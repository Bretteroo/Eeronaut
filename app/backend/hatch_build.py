"""Generate the gRPC client code for eero's local control plane at install.

The `.proto` files under eeronaut/proto are the source; the `_pb2.py` and
`_pb2_grpc.py` beside them are compiled from them here, by the `pip install`
that every install and update already runs, and are not committed. Committed
output drifts from its source and from the protobuf runtime it was written
for, and a runtime older than the code refuses to load it.

The compiler comes from grpcio-tools, pinned in pyproject.toml's build
requirements. pip installs it into a throwaway build environment, so it never
becomes part of the installed program. Its version decides the protobuf
version the generated code checks for when it loads, which is why the
runtime floors in the `local` extra are set against it.
"""
from __future__ import annotations

from importlib.resources import files
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class ProtoBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        from grpc_tools import protoc

        root = Path(self.root) / "eeronaut" / "proto"
        protos = sorted(str(p) for p in root.rglob("*.proto"))
        if not protos:
            raise RuntimeError(f"no .proto files under {root}")
        # google/protobuf/timestamp.proto and the rest of the well-known
        # types ship inside grpc_tools.
        well_known = str(files("grpc_tools") / "_proto")
        code = protoc.main([
            "grpc_tools.protoc",
            f"--proto_path={root}",
            f"--proto_path={well_known}",
            f"--python_out={root}",
            f"--grpc_python_out={root}",
            *protos,
        ])
        if code != 0:
            raise RuntimeError(f"protoc failed with exit status {code}")
