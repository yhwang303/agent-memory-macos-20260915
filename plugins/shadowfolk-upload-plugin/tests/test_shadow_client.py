import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from shadowfolk_upload.shadow_client import ShadowClient, ShadowClientError


class Handler(BaseHTTPRequestHandler):
    records = {}
    raw_payloads = []

    def _send(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer sf_test":
            self._send(401, {"error": "unauthorized"})
            return
        if self.path.startswith("/api/push/push-records/"):
            record = self.records.get(self.path)
            if record is None:
                self._send(404, {"error": "not found"})
            else:
                self._send(200, {"record": record})
            return
        self._send(404, {"error": "unknown"})

    def do_POST(self):
        if self.path == "/api/push/raw":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
            self.raw_payloads.append(body)
            self._send(
                201,
                {
                    "batch_id": "batch_1",
                    "observations_count": len(body["memory"]["observations"]),
                    "summaries_count": len(body["memory"]["session_summaries"]),
                },
            )
            return
        self._send(404, {"error": "unknown"})

    def do_PUT(self):
        if self.path.startswith("/api/push/push-records/"):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
            self.records[self.path] = body
            self._send(200, {"record": body})
            return
        self._send(404, {"error": "unknown"})

    def log_message(self, format, *args):
        return


class ShadowClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Handler.records = {}
        Handler.raw_payloads = []

    def test_missing_push_record_returns_none(self):
        client = ShadowClient(self.base_url, "sf_test")

        self.assertIsNone(client.get_push_record("E:/Github/app"))

    def test_push_raw_and_update_record(self):
        client = ShadowClient(self.base_url, "sf_test")
        payload = {
            "git": {"root": "E:/Github/app", "commits": [], "stats": {}},
            "memory": {
                "scope": "E:/Github/app",
                "excluded_prefixes": [],
                "observations": [{"id": 2}],
                "session_summaries": [{"id": 3}],
            },
        }

        result = client.push_raw(payload)
        record = client.update_push_record("E:/Github/app", {"last_observation_id": 2, "last_summary_id": 3})

        self.assertEqual(result["batch_id"], "batch_1")
        self.assertEqual(record["last_observation_id"], 2)
        self.assertEqual(len(Handler.raw_payloads), 1)

    def test_auth_error_raises_non_retryable_error(self):
        client = ShadowClient(self.base_url, "wrong")

        with self.assertRaises(ShadowClientError) as ctx:
            client.get_push_record("E:/Github/app")

        self.assertFalse(ctx.exception.retryable)
        self.assertEqual(ctx.exception.status, 401)
