"""Local DAV fixture for installed-app integration tests; never serves outside loopback."""
import argparse
import datetime
import email.utils
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
import xml.etree.ElementTree as ET


class DavHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def path_for_request(self):
        path = unquote(urlsplit(self.path).path)
        if "\x00" in path or ".." in Path(path).parts or "\\" in path:
            raise ValueError("Invalid fixture path")
        target = (self.server.storage / path.lstrip("/")).resolve()
        if not target.is_relative_to(self.server.storage):
            raise ValueError("Path leaves fixture storage")
        return target

    def send_result(self, status, body=b"", content_type="application/octet-stream", length=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body) if length is None else length))
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except ValueError as error:
            self.send_result(400, str(error).encode())
        except (ConnectionError, BrokenPipeError):
            pass

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("DAV", "1,2")
        self.send_header("Allow", "OPTIONS,PROPFIND,MKCOL,PUT,GET,HEAD,DELETE")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_MKCOL(self):
        target = self.path_for_request()
        if target.exists():
            self.send_result(405)
        elif not target.parent.is_dir():
            self.send_result(409)
        else:
            target.mkdir()
            self.send_result(201)

    def do_PUT(self):
        target = self.path_for_request()
        length = int(self.headers.get("Content-Length", "-1"))
        if length < 0 or length > 128 * 1024 * 1024:
            self.send_result(413)
            self.close_connection = True
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".upload")
        remaining = length
        with temporary.open("wb") as output:
            while remaining:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    temporary.unlink(missing_ok=True)
                    raise ConnectionError("Incomplete upload")
                output.write(chunk)
                remaining -= len(chunk)
        temporary.replace(target)
        self.send_result(201)

    def do_GET(self):
        target = self.path_for_request()
        if not target.is_file():
            self.send_result(404)
        else:
            self.send_result(200, target.read_bytes())

    def do_HEAD(self):
        target = self.path_for_request()
        self.send_result(200 if target.exists() else 404, length=target.stat().st_size if target.is_file() else 0)

    def do_DELETE(self):
        target = self.path_for_request()
        if not target.exists():
            self.send_result(404)
        elif target.is_file():
            target.unlink()
            self.send_result(204)
        elif target != self.server.storage and not any(target.iterdir()):
            target.rmdir()
            self.send_result(204)
        else:
            self.send_result(409)

    def do_PROPFIND(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1024 * 1024:
            self.send_result(413)
            self.close_connection = True
            return
        self.rfile.read(length)
        target = self.path_for_request()
        if not target.exists():
            self.send_result(404)
            return
        entries = [target]
        if target.is_dir() and self.headers.get("Depth", "1") != "0":
            entries += sorted(target.iterdir())
        ET.register_namespace("d", "DAV:")
        root = ET.Element("{DAV:}multistatus")
        for entry in entries:
            if entry.name.endswith(".upload"):
                continue
            response = ET.SubElement(root, "{DAV:}response")
            relative = entry.relative_to(self.server.storage).as_posix()
            href = "/" + ("" if relative == "." else quote(relative)) + ("/" if entry.is_dir() and relative != "." else "")
            ET.SubElement(response, "{DAV:}href").text = href
            propstat = ET.SubElement(response, "{DAV:}propstat")
            prop = ET.SubElement(propstat, "{DAV:}prop")
            resource = ET.SubElement(prop, "{DAV:}resourcetype")
            if entry.is_dir():
                ET.SubElement(resource, "{DAV:}collection")
            stat = entry.stat()
            ET.SubElement(prop, "{DAV:}getcontentlength").text = str(stat.st_size if entry.is_file() else 0)
            ET.SubElement(prop, "{DAV:}getlastmodified").text = email.utils.formatdate(stat.st_mtime, usegmt=True)
            ET.SubElement(prop, "{DAV:}creationdate").text = datetime.datetime.fromtimestamp(stat.st_mtime, datetime.timezone.utc).isoformat()
            ET.SubElement(propstat, "{DAV:}status").text = "HTTP/1.1 200 OK"
        self.send_result(207, ET.tostring(root, encoding="utf-8", xml_declaration=True), "application/xml; charset=utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--data", type=Path, default=Path(".cache/webdav-fixture"))
    args = parser.parse_args()
    args.data.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), DavHandler)
    server.storage = args.data.resolve()
    print(json.dumps({"endpoint": f"http://127.0.0.1:{args.port}/", "storage": str(server.storage)}), flush=True)
    server.serve_forever()
