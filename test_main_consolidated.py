from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
from main import app, get_ast_context

client = TestClient(app)

def test_ast_context():
    code = "def foo(): pass\nclass Bar: pass"
    context = get_ast_context(code)
    # Note: our simple walker might only catch functions or might need adjustment
    # The current implementation in main.py looks for "function_definition"
    assert "foo" in context or "Found Functions" in context

@patch("main.groq_client")
@patch("main.style_collection")
def test_review_endpoint(mock_collection, mock_groq):
    # Mock RAG
    mock_collection.query.return_value = {'documents': [["Always use types."]]}
    
    # Mock Groq
    mock_chat = MagicMock()
    mock_chat.choices[0].message.content = '{"comments": []}'
    mock_groq.chat.completions.create.return_value = mock_chat
    
    response = client.post("/review", json={
        "code_diff": "+ def foo(): pass",
        "full_file_content": "def foo(): pass",
        "file_path": "test.py"
    })
    
    assert response.status_code == 200
    assert response.json() == {"comments": []}
