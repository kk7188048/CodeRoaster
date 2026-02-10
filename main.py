import os
import uvicorn
from fastapi import FastAPI, HTTPException
from dotenv import load_dotenv

load_dotenv()
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

# 1. Groq (LLM)
from groq import Groq

# 2. ChromaDB (Vector Memory)
import chromadb
from chromadb.config import Settings

# 3. Tree-sitter (AST Parsing)
# NOTE: New 2025 usage requires specific language binding imports
from tree_sitter import Language, Parser
import tree_sitter_python as tspython

app = FastAPI(title="DevSentinel Backend")

# --- CONFIGURATION ---
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    print("⚠️ WARNING: GROQ_API_KEY not found in environment variables.")

# Initialize Clients
groq_client = Groq(api_key=GROQ_API_KEY)

# Initialize Vector DB (Persistent storage in ./chroma_db folder)
chroma_client = chromadb.PersistentClient(path="./chroma_db")
style_collection = chroma_client.get_or_create_collection(name="style_guide")

# Initialize AST Parser for Python
PY_LANGUAGE = Language(tspython.language())
parser = Parser(PY_LANGUAGE)

# --- DATA MODELS ---
class ReviewRequest(BaseModel):
    code_diff: str          # The changes (git diff)
    full_file_content: str  # Context for AST
    file_path: str          # filename (e.g., "auth.py")

class CodeFix(BaseModel):
    line_number: int
    suggestion: str
    fixed_code: str         # The ready-to-apply code

class ReviewResponse(BaseModel):
    comments: List[CodeFix]

# --- HELPER FUNCTIONS ---
def get_ast_context(code: str) -> str:
    """
    Parses code to find the high-level structure (Class/Function names).
    This helps the LLM know WHERE the diff is happening.
    """
    try:
        tree = parser.parse(bytes(code, "utf8"))
        root_node = tree.root_node
        
        # Simple walk to find function definitions
        functions = []
        cursor = tree.walk()
        
        visited_children = False
        while True:
            if not visited_children:
                if cursor.node.type == "function_definition":
                    # Extract function name
                    name_node = cursor.node.child_by_field_name("name")
                    if name_node:
                        functions.append(code[name_node.start_byte:name_node.end_byte])
            
            if cursor.goto_first_child():
                visited_children = False
            elif cursor.goto_next_sibling():
                visited_children = False
            elif cursor.goto_parent():
                visited_children = True
            else:
                break
                
        return f"Found Functions: {', '.join(functions)}" if functions else "Root Level Script"
    except Exception as e:
        return f"AST Parse Error: {str(e)}"

# --- API ENDPOINTS ---

@app.get("/")
def health_check():
    return {"status": "DevSentinel Brain is Active", "model": "llama-3.3-70b-versatile"}

@app.post("/ingest-style")
async def ingest_style_guide(content: str):
    """
    Uploads a STYLE_GUIDE.md to the Vector DB.
    """
    # Clear old rules to keep it fresh
    existing_ids = style_collection.get()['ids']
    if existing_ids:
        style_collection.delete(ids=existing_ids)

    # Chunk by paragraphs (simple strategy)
    chunks = [c.strip() for c in content.split("\n\n") if c.strip()]
    ids = [str(i) for i in range(len(chunks))]
    
    if chunks:
        style_collection.add(documents=chunks, ids=ids)
        return {"status": "success", "chunks_indexed": len(chunks)}
    return {"status": "empty_content"}

@app.post("/review", response_model=ReviewResponse)
async def review_code(request: ReviewRequest):
    # 1. AST Analysis
    ast_context = get_ast_context(request.full_file_content)

    # 2. RAG Retrieval (Fetch relevant style rules)
    # We query the DB using the Diff text to find relevant rules
    rag_results = style_collection.query(
        query_texts=[request.code_diff],
        n_results=3
    )
    style_rules = "\n- ".join(rag_results['documents'][0]) if rag_results['documents'] else "Standard PEP8."

    # 3. Construct Prompt
    system_prompt = f"""
    You are a Senior Python Architect.
    
    CONTEXT:
    - Structure: {ast_context}
    - Style Rules: 
      - {style_rules}
    
    TASK:
    Review the Git Diff below. Return a JSON object with a list of "comments".
    For each issue, provide the 'line_number', a short 'suggestion', and the 'fixed_code'.
    
    CRITICAL: 
    - Output MUST be valid JSON.
    - If the code is good, return an empty list: {{ "comments": [] }}
    - Focus on bugs, security, and the Style Rules provided.
    """

    # 4. Call Groq (Llama 3.3 70B is the best balance of speed/smarts)
    try:
        completion = groq_client.chat.completions.create(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"FILE: {request.file_path}\nDIFF:\n{request.code_diff}"}
            ],
            model="llama-3.3-70b-versatile",
            response_format={"type": "json_object"}
        )
        
        # Parse output
        return ReviewResponse.model_validate_json(completion.choices[0].message.content)
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)