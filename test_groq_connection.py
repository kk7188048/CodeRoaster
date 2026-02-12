import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ.get("GROQ_API_KEY")
print(f"API Key present: {bool(api_key)}")
if api_key:
    # Print first few chars to verify it's not "dummy" or empty (masked)
    print(f"API Key prefix: {api_key[:4]}...")

try:
    client = Groq(api_key=api_key)
    chat_completion = client.chat.completions.create(
        messages=[
            {
                "role": "user",
                "content": "Explain JSON in 1 sentence.",
            }
        ],
        model="llama-3.3-70b-versatile",
    )
    print("Response received:")
    print(chat_completion.choices[0].message.content)
except Exception as e:
    print(f"Error: {e}")
