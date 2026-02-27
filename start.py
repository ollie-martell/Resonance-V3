import os
import subprocess

port = os.environ.get("PORT", "8080")
subprocess.run([
    "gunicorn", "app:app",
    "--bind", f"0.0.0.0:{port}",
    "--workers", "1",
    "--timeout", "300",
])
