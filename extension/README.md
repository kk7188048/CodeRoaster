# DevSentinel

DevSentinel is an AI-powered Code Review & Architecture Assistant. It uses a Python backend (Brain) to analyze your code diffs and suggest improvements directly in VS Code.

## Features

- **Code Review**: Analyze your Git changes with `DevSentinel: Review Changes`.
- **Quick Fixes**: Apply suggested fixes with a single click (Lightbulb).
- **Extensible**: Configure the backend URL to point to your local or remote instance.

## Usage

1.  Ensure the DevSentinel Backend is running (default: `http://127.0.0.1:8000`).
2.  Open a folder with a Git repository.
3.  Make changes to a file.
4.  Run command: `DevSentinel: Review Changes`.
5.  Check for warnings/diagnostics in your code.

## Configuration

- `devsentinel.backendUrl`: URL of the backend (default: `http://127.0.0.1:8000`).
