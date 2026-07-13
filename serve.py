#!/usr/bin/env python3
"""Serve the app locally.

HTTP on :8000 (fine for desktop testing at http://localhost:8000).
HTTPS on :8443 — needed for camera/GPS/compass on a phone. A self-signed
certificate is generated on first run; accept the browser warning on the phone.

Usage:  python3 serve.py
"""
import http.server
import os
import socket
import ssl
import subprocess
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(ROOT, "dev-cert.pem")
KEY = os.path.join(ROOT, "dev-key.pem")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert():
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY, "-out", CERT, "-days", "365",
        "-subj", "/CN=zurich-tunnel-ar.local",
        "-addext", f"subjectAltName=IP:{lan_ip()},DNS:localhost",
    ], check=True)


def serve_http():
    try:
        http.server.ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
    except OSError as e:
        print(f"http :8000 not started ({e}) — https on :8443 still works")


def serve_https():
    ensure_cert()
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", 8443), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    httpd.serve_forever()


if __name__ == "__main__":
    ip = lan_ip()
    print(f"desktop:  http://localhost:8000")
    print(f"phone:    https://{ip}:8443   (accept the certificate warning)")
    threading.Thread(target=serve_http, daemon=True).start()
    serve_https()
