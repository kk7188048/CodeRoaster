import os
import re
import json
import logging
import uvicorn
from fastapi import FastAPI, HTTPException, Body
from dotenv import load_dotenv

load_dotenv()
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any, Literal

# logger = logging.getLogger("devsentinel")


# 1. Groq (LLM)
from groq import Groq

# 2. ChromaDB (Vector Memory)
import chromadb
from chromadb.config import Settings

# 3. Tree-sitter (AST Parsing)
# NOTE: New 2025 usage requires specific language binding imports
from tree_sitter import Language, Parser
import tree_sitter_python as tspython
import tree_sitter_javascript as tsjavascript
import tree_sitter_typescript as tstypescript

app = FastAPI(title="DevSentinel Backend")

# --- CONFIGURATION ---
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    print("⚠️ WARNING: GROQ_API_KEY not found in environment variables.")

# Initialize Clients
groq_client = Groq(api_key=GROQ_API_KEY)

# Initialize Vector DB (lazy — initialized on first use to avoid blocking)
_chroma_client = None
_style_collection = None

def get_style_collection():
    global _chroma_client, _style_collection
    print("[DEBUG] Getting style collection...")
    if _style_collection is None:
        print("[DEBUG] Initializing ChromaDB client...")
        _chroma_client = chromadb.PersistentClient(path="./chroma_db")
        _style_collection = _chroma_client.get_or_create_collection(name="style_guide")
        print("[DEBUG] ChromaDB client initialized and collection created/retrieved.")
    else:
        print("[DEBUG] Using cached style collection.")
    return _style_collection

# Initialize AST Language Map (keyed by file extension)
LANGUAGE_MAP = {
    ".py": Language(tspython.language()),
    ".js": Language(tsjavascript.language()),
    ".jsx": Language(tsjavascript.language()),
    ".ts": Language(tstypescript.language_typescript()),
    ".tsx": Language(tstypescript.language_tsx()),
}

LANGUAGE_NAMES = {
    ".py": "Python",
    ".js": "JavaScript",
    ".jsx": "JavaScript (JSX)",
    ".ts": "TypeScript",
    ".tsx": "TypeScript (TSX)",
}

AST_FUNCTION_TYPES = {
    ".py": {"function_definition", "class_definition"},
    ".js": {"function_declaration", "arrow_function", "class_declaration", "method_definition"},
    ".jsx": {"function_declaration", "arrow_function", "class_declaration", "method_definition"},
    ".ts": {"function_declaration", "arrow_function", "class_declaration", "method_definition"},
    ".tsx": {"function_declaration", "arrow_function", "class_declaration", "method_definition"},
}

DEFAULT_STYLE_RULES = {
    ".py": "Standard PEP8.",
    ".js": "Standard ESLint recommended rules.",
    ".jsx": "Standard ESLint recommended rules with React best practices.",
    ".ts": "Standard TypeScript ESLint recommended rules.",
    ".tsx": "Standard TypeScript ESLint recommended rules with React best practices.",
}

# --- CONSTANTS ---
MAX_CODE_LENGTH = 100_000  # ~100KB max per field

# --- DATA MODELS ---
class ReviewRequest(BaseModel):
    full_file_content: str = Field(..., max_length=MAX_CODE_LENGTH)
    file_path: str = Field(..., max_length=500)

class CodeFix(BaseModel):
    line_number: int
    suggestion: str
    fixed_code: str
    severity: Literal["error", "warning", "info", "hint"] = "warning"

class ReviewResponse(BaseModel):
    comments: List[CodeFix]

# --- HELPER FUNCTIONS ---
def safe_error_message(e: Exception) -> str:
    """Strip anything that looks like an API key from error messages."""
    msg = str(e)
    # Redact long alphanumeric tokens (API keys are typically 30+ chars)
    msg = re.sub(r'(gsk_|sk-)[A-Za-z0-9_-]{20,}', '[REDACTED]', msg)
    return msg

def clean_llm_json(raw: str) -> str:
    """Strip markdown fences and fix common LLM JSON issues."""
    text = raw.strip()
    # Remove ```json ... ``` wrappers
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text)
    return text.strip()

def get_language_name(file_path: str) -> str:
    """Return a human-readable language name from the file extension."""
    ext = os.path.splitext(file_path)[1].lower()
    return LANGUAGE_NAMES.get(ext, "General")

def get_ast_context(code: str, file_path: str) -> str:
    print(f"[DEBUG] Parsing AST for file: {file_path}")
    """
    Parses code to find the high-level structure (Class/Function names).
    This helps the LLM know WHERE the diff is happening.
    Supports Python, JavaScript, and TypeScript.
    """
    ext = os.path.splitext(file_path)[1].lower()
    language = LANGUAGE_MAP.get(ext)
    print(f"[INFO] AST parsing for '{ext}' files.")
    if not language:
        return f"AST parsing not available for '{ext}' files. Reviewing as plain text."

    try:
        local_parser = Parser(language)
        tree = local_parser.parse(bytes(code, "utf8"))
        function_types = AST_FUNCTION_TYPES.get(ext, set())

        functions = []
        cursor = tree.walk()

        visited_children = False
        loop_count = 0
        while True:
            loop_count += 1
            if loop_count > 100000:
                print(f"[WARNING] AST traversal limit reached for {file_path}. Stopping early.")
                break

            if not visited_children:
                node = cursor.node
                if node.type in function_types:
                    name_node = node.child_by_field_name("name")
                    if name_node:
                        functions.append(code[name_node.start_byte:name_node.end_byte])
                    elif node.type == "arrow_function":
                        # Arrow functions: check parent variable_declarator for name
                        parent = node.parent
                        if parent and parent.type == "variable_declarator":
                            pname = parent.child_by_field_name("name")
                            if pname:
                                functions.append(code[pname.start_byte:pname.end_byte])
                            else:
                                functions.append("<anonymous arrow>")
                        else:
                            functions.append("<anonymous arrow>")

            if cursor.goto_first_child():
                visited_children = False
            elif cursor.goto_next_sibling():
                visited_children = False
            elif cursor.goto_parent():
                visited_children = True
            else:
                break

        result = f"Found Functions: {', '.join(functions)}" if functions else "Root Level Script"
        print(f"[DEBUG] AST Parsing result: {result}")
        return result
    except Exception as e:
        print(f"[ERROR] AST Parse Error: {str(e)}")
        return f"AST Parse Error: {str(e)}"

# --- API ENDPOINTS ---

@app.get("/")
def health_check():
    return {"status": "DevSentinel Brain is Active", "model": "llama-3.3-70b-versatile"}

@app.post("/ingest-style")
def ingest_style_guide(content: str = Body(..., max_length=MAX_CODE_LENGTH)):
    """
    Uploads a STYLE_GUIDE.md to the Vector DB.
    """
    # Clear old rules to keep it fresh
    collection = get_style_collection()
    existing_ids = collection.get()['ids']
    if existing_ids:
        collection.delete(ids=existing_ids)

    # Chunk by paragraphs (simple strategy)
    chunks = [c.strip() for c in content.split("\n\n") if c.strip()]
    ids = [str(i) for i in range(len(chunks))]

    if chunks:
        collection.add(documents=chunks, ids=ids)
        return {"status": "success", "chunks_indexed": len(chunks)}
    return {"status": "empty_content"}

@app.post("/review", response_model=ReviewResponse)
def review_code(request: ReviewRequest):
    # 1. AST Analysis
    print(f"[INFO] Received review request for {request.file_path}")

    ast_context = get_ast_context(request.full_file_content, request.file_path)
    print(f"[INFO] AST Context: {ast_context}")
    # 2. RAG Retrieval (Fetch relevant style rules)
    print("[INFO] Querying RAG...")
    ext = os.path.splitext(request.file_path)[1].lower()
    default_rules = DEFAULT_STYLE_RULES.get(ext, "General best practices.")
    rag_results = get_style_collection().query(
        query_texts=[request.full_file_content[:500]],
        n_results=3
    )
    if rag_results['documents']:
        print(f"[DEBUG] Found {len(rag_results['documents'][0])} RAG documents.")
        style_rules = "\n- ".join(rag_results['documents'][0])
    else:
        print("[DEBUG] No RAG documents found, using default rules.")
        style_rules = default_rules

    # 3. Construct Prompt
    language_name = get_language_name(request.file_path)
    system_prompt = f"""
    You are a Senior {language_name} Architect reviewing code for project alignment and quality.

    CONTEXT:
    - File Structure: {ast_context}
    - Project Style Rules:
      - {style_rules}

    TASK:
    Review the ENTIRE file for:
    1. Project alignment — does the code follow consistent patterns, naming conventions, and architecture?
    2. Bugs and logic errors
    3. Security vulnerabilities
    4. Code quality — readability, maintainability, proper error handling
    5. Style rule compliance (see above)

    Return a JSON object with a list of "comments".
    For each issue, provide:
    - 'line_number': The ABSOLUTE line number in the file (1-based).
    - 'suggestion': A short, actionable suggestion.
    - 'fixed_code': The corrected line(s) of code.
    - 'severity': One of "error", "warning", "info", or "hint".
      - "error": bugs, crashes, security vulnerabilities
      - "warning": code smells, poor patterns, potential issues
      - "info": style/readability improvements
      - "hint": optional suggestions, nice-to-haves

    CRITICAL:
    - Output MUST be valid JSON.
    - If the code is good, return an empty list: {{ "comments": [] }}
    - Review the WHOLE file, not just parts of it.
    """

    # 4. Call Groq
    print("[INFO] Calling Groq API...")
    try:
        completion = groq_client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"FILE: {request.file_path}\n\nCODE:\n{request.full_file_content}"}
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"}
        )

        raw_content = completion.choices[0].message.content
        print("[INFO] Groq response received. Parsing...")

        # Try direct parse first, then clean and retry
        try:
            return ReviewResponse.model_validate_json(raw_content)
        except Exception:
            cleaned = clean_llm_json(raw_content)
            try:
                data = json.loads(cleaned)
                return ReviewResponse.model_validate(data)
            except Exception:
                # If JSON is valid but missing "comments" key, wrap it
                print(f"[WARNING] LLM returned unparseable response: {cleaned[:200]}")
                return ReviewResponse(comments=[])

    except Exception as e:
        print(f"[ERROR] in review_code: {str(e)}")
        raise HTTPException(status_code=500, detail=safe_error_message(e))

class RoastRequest(BaseModel):
    full_file_content: str = Field(..., max_length=MAX_CODE_LENGTH)
    file_path: str = Field(..., max_length=500)

@app.post("/roast")
def roast_code(request: RoastRequest):
    """
    Roasts the code in the style of Linus Torvalds.
    """
    print(f"[INFO] Roasting {request.file_path}...")
    
    system_prompt = """
    You are Linus Torvalds. 
    The user has sent you some code. It is probably terrible.
    Your job is to ROAST it. Be brutal, be technical, be funny, but also be educational (deep down).
    
    Rules:
    - Use CAPS for emphasis.
    - Question their life choices.
    - Compare their code to spaghetti, garbage, or worse.
    - BUT, point out actual flaws (logic, variable names, architecture).
    - Keep it under 200 words.
    """
    
    try:
        completion = groq_client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"FILE: {request.file_path}\nCONTENT:\n{request.full_file_content}"}
            ],
            model="llama-3.3-70b-versatile"
        )
        roast = completion.choices[0].message.content
        return {"roast": roast}
    except Exception as e:
        print(f"[ERROR] in roast_code: {str(e)}")
        raise HTTPException(status_code=500, detail=safe_error_message(e))

# --- Feature 3: Security Scan ---
class SecurityScanRequest(BaseModel):
    full_file_content: str = Field(..., max_length=MAX_CODE_LENGTH)
    file_path: str = Field(..., max_length=500)

@app.post("/security-scan", response_model=ReviewResponse)
def security_scan(request: SecurityScanRequest):
    """Perform a security-focused scan of the code targeting OWASP Top 10."""
    print(f"[INFO] Security scan requested for {request.file_path}")

    language_name = get_language_name(request.file_path)
    ast_context = get_ast_context(request.full_file_content, request.file_path)

    system_prompt = f"""
    You are a Senior Application Security Engineer specializing in {language_name}.

    CONTEXT:
    - Code Structure: {ast_context}

    TASK:
    Perform a thorough security audit of the provided code. Focus on OWASP Top 10 vulnerabilities:
    1. SQL Injection
    2. Cross-Site Scripting (XSS)
    3. Path Traversal / Directory Traversal
    4. Hardcoded Secrets (API keys, passwords, tokens)
    5. Command Injection (os.system, exec, eval, child_process)
    6. Insecure Deserialization (pickle, yaml.load, eval)
    7. Broken Access Control
    8. Sensitive Data Exposure (logging secrets, error messages leaking info)
    9. Insecure Cryptography (weak hashing, hardcoded IVs, ECB mode)
    10. Server-Side Request Forgery (SSRF)

    Return a JSON object with a list of "comments".
    For each vulnerability found, provide:
    - 'line_number': The ABSOLUTE line number (1-based).
    - 'suggestion': Description of the vulnerability and how to fix it.
    - 'fixed_code': The secure version of the code.
    - 'severity': One of "error", "warning", "info", or "hint".
      - "error": confirmed vulnerabilities (injection, hardcoded secrets, command injection)
      - "warning": likely vulnerabilities or unsafe patterns
      - "info": security best practice suggestions
      - "hint": minor hardening suggestions

    CRITICAL:
    - Output MUST be valid JSON.
    - If the code has no security issues, return: {{ "comments": [] }}
    - Only report real security concerns, not general code quality.
    """

    try:
        completion = groq_client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"FILE: {request.file_path}\n\nCODE:\n{request.full_file_content}"}
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"}
        )

        raw_content = completion.choices[0].message.content
        print("[INFO] Security scan response received. Parsing...")

        try:
            return ReviewResponse.model_validate_json(raw_content)
        except Exception:
            cleaned = clean_llm_json(raw_content)
            try:
                data = json.loads(cleaned)
                return ReviewResponse.model_validate(data)
            except Exception:
                print(f"[WARNING] Security scan LLM returned unparseable response: {cleaned[:200]}")
                return ReviewResponse(comments=[])

    except Exception as e:
        print(f"[ERROR] in security_scan: {str(e)}")
        raise HTTPException(status_code=500, detail=safe_error_message(e))


# --- Feature 4: Complexity Analysis ---
COMPLEXITY_THRESHOLD = 10

BRANCH_TYPES = {
    ".py": {"if_statement", "for_statement", "while_statement", "try_statement",
            "except_clause", "with_statement", "conditional_expression",
            "boolean_operator"},
    ".js": {"if_statement", "for_statement", "for_in_statement", "while_statement",
            "do_statement", "try_statement", "catch_clause", "switch_case",
            "ternary_expression", "binary_expression"},
    ".jsx": {"if_statement", "for_statement", "for_in_statement", "while_statement",
             "do_statement", "try_statement", "catch_clause", "switch_case",
             "ternary_expression", "binary_expression"},
    ".ts": {"if_statement", "for_statement", "for_in_statement", "while_statement",
            "do_statement", "try_statement", "catch_clause", "switch_case",
            "ternary_expression", "binary_expression"},
    ".tsx": {"if_statement", "for_statement", "for_in_statement", "while_statement",
             "do_statement", "try_statement", "catch_clause", "switch_case",
             "ternary_expression", "binary_expression"},
}

# Node types that represent function boundaries (to skip nested functions)
FUNCTION_BOUNDARY_TYPES = {
    ".py": {"function_definition"},
    ".js": {"function_declaration", "arrow_function", "method_definition"},
    ".jsx": {"function_declaration", "arrow_function", "method_definition"},
    ".ts": {"function_declaration", "arrow_function", "method_definition"},
    ".tsx": {"function_declaration", "arrow_function", "method_definition"},
}

class FunctionComplexity(BaseModel):
    name: str
    line_number: int
    complexity: int
    is_complex: bool

class ComplexityRequest(BaseModel):
    full_file_content: str = Field(..., max_length=MAX_CODE_LENGTH)
    file_path: str = Field(..., max_length=500)

class ComplexityResponse(BaseModel):
    functions: List[FunctionComplexity]
    threshold: int = COMPLEXITY_THRESHOLD


def _count_branches(node, branch_types: set, boundary_types: set, code: str, ext: str) -> int:
    """Count branch nodes within a function, stopping at nested function boundaries."""
    count = 0
    for child in node.children:
        if child.type in boundary_types:
            # Don't recurse into nested functions
            continue
        if child.type in branch_types:
            # For JS/TS binary_expression, only count && and ||
            if child.type == "binary_expression":
                op_node = child.child_by_field_name("operator")
                if op_node:
                    op_text = code[op_node.start_byte:op_node.end_byte]
                    if op_text in ("&&", "||"):
                        count += 1
            else:
                count += 1
        count += _count_branches(child, branch_types, boundary_types, code, ext)
    return count


def compute_complexity(code: str, file_path: str) -> List[FunctionComplexity]:
    """Compute cyclomatic complexity for each function in the file."""
    print(f"[DEBUG] Starting compute_complexity for {file_path}")
    ext = os.path.splitext(file_path)[1].lower()
    language = LANGUAGE_MAP.get(ext)
    if not language:
        print(f"[WARNING] Language not supported for complexity analysis: {ext}")
        return []

    local_parser = Parser(language)
    tree = local_parser.parse(bytes(code, "utf8"))
    function_types = AST_FUNCTION_TYPES.get(ext, set())
    branch_types = BRANCH_TYPES.get(ext, set())
    boundary_types = FUNCTION_BOUNDARY_TYPES.get(ext, set())

    results = []
    cursor = tree.walk()

    visited_children = False
    loop_count = 0
    while True:
        loop_count += 1
        if loop_count > 100000:
            print("BREAKING: Infinite loop detected in AST traversal")
            break

        if not visited_children:
            node = cursor.node
            if node.type in function_types:
                # Get function name
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = code[name_node.start_byte:name_node.end_byte]
                elif node.type == "arrow_function":
                    parent = node.parent
                    if parent and parent.type == "variable_declarator":
                        pname = parent.child_by_field_name("name")
                        name = code[pname.start_byte:pname.end_byte] if pname else "<anonymous>"
                    else:
                        name = "<anonymous>"
                else:
                    name = "<anonymous>"

                print(f"DEBUG: Found function '{name}' at line {node.start_point[0] + 1}")
                
                try:
                    # Base complexity = 1, plus one for each branch
                    branch_count = _count_branches(node, branch_types, boundary_types, code, ext)
                    complexity = 1 + branch_count
                    line_number = node.start_point[0] + 1  # 0-based to 1-based
                    
                    print(f"DEBUG: Analyzed '{name}' -> Complexity: {complexity}")

                    results.append(FunctionComplexity(
                        name=name,
                        line_number=line_number,
                        complexity=complexity,
                        is_complex=complexity > COMPLEXITY_THRESHOLD,
                    ))
                except Exception as ex:
                     print(f"ERROR calculating complexity for {name}: {str(ex)}")

        if cursor.goto_first_child():
            visited_children = False
        elif cursor.goto_next_sibling():
            visited_children = False
        elif cursor.goto_parent():
            visited_children = True
        else:
            break

    print(f"DEBUG: Completed complexity analysis for {file_path}. Found {len(results)} functions.")
    return results


@app.post("/complexity", response_model=ComplexityResponse)
def analyze_complexity(request: ComplexityRequest):
    """Compute cyclomatic complexity for all functions in the file."""
    print(f"[INFO] Complexity analysis requested for {request.file_path}")
    try:
        functions = compute_complexity(request.full_file_content, request.file_path)
        return ComplexityResponse(functions=functions)
    except Exception as e:
        print(f"[ERROR] in analyze_complexity: {str(e)}")
        raise HTTPException(status_code=500, detail=safe_error_message(e))


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)