"""Development entry point.

Run the app with:   python run.py
Then open:          http://127.0.0.1:8000

`reload=True` restarts the server automatically whenever you save a file.
In production you would run uvicorn directly (see Step 7).
"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
