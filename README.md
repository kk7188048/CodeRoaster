# DevSentinel / CodeRoaster

DevSentinel is a VS Code extension powered by a standard Python/FastAPI backend that provides AI-driven code review, security scanning, complexity analysis, and "roasting" features.

## Features

- **AI Code Review**: Get intelligent suggestions and fixes for your code.
- **Security Scan**: Identify potential vulnerabilities (OWASP Top 10 focus).
- **Complexity Analysis**: Calculate cyclomatic complexity and identify complex functions.
- **Roast Mode**: Get a humorous, Linus Torvalds-style critique of your code.
- **Activity Bar View**: Dedicated sidebar for quick access to all features.

## Prerequisites

- **Python 3.8+**
- **Node.js 16+**
- **VS Code**
- **Groq API Key**: You need an API key from [Groq](https://console.groq.com/) for the AI features.

## Setup Instructions

### 1. Backend Setup (Python)

The backend handles the core logic, AST parsing, and AI interactions.

1.  Navigate to the project root (where `main.py` is located).
2.  Create a virtual environment:
    ```bash
    python -m venv .venv
    ```
3.  Activate the virtual environment:
    - **Mac/Linux**: `source .venv/bin/activate`
    - **Windows**: `.venv\Scripts\activate`
4.  Install dependencies:
    ```bash
    pip install -r requirement.txt
    ```
5.  Create a `.env` file in the root directory and add your Groq API Key:
    ```env
    GROQ_API_KEY=your_groq_api_key_here
    ```
6.  Start the server:
    ```bash
    uvicorn main:app --reload --port 8000
    ```
    The backend should now be running at `http://127.0.0.1:8000`.

### 2. Extension Setup (VS Code)

The extension provides the UI and communicates with the backend.

1.  Navigate to the `extension` directory:
    ```bash
    cd extension
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Compile the extension:
    ```bash
    npm run compile
    ```
4.  **Run in VS Code**:
    - Open the project in VS Code.
    - Press **F5** to start debugging. A new "Extension Development Host" window will open with the extension loaded.

## Usage

1.  Open a file in the Extension Development Host window.
2.  Click the **DevSentinel** icon in the Activity Bar (left side).
3.  Use the buttons in the sidebar to:
    - **Review File**: trigger a code review.
    - **Roast Code**: get a roast.
    - **Security Scan**: check for vulnerabilities.
    - **Complexity**: analyze function complexity.
4.  You can also use the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type `DevSentinel`.

## Configuration

You can configure the extension in VS Code Settings:

- `devsentinel.backendUrl`: URL of the Python backend (default: `http://127.0.0.1:8000`).
- `devsentinel.requestTimeout`: Timeout for AI requests in milliseconds (default: `300000`).
