# Documentation

## Current behavior

- [Architecture](architecture.md) / [中文](architecture.zh-CN.md)
- [Deployment](deployment.md) / [中文](deployment.zh-CN.md)
- [AI model connections](ai-models-connections.md) and [native configuration](model-config-native.md)
- [Universal sandbox](universal-sandbox.md) and [profiles](sandbox-profiles.md)
- [Skill authoring](skill-authoring.md)
- [Auto Research](auto-research.md) and [task execution](task-execution.md)
- [Web access and MCP](web-access-mcp.md)

## Maintainer references

- [Server service ownership and protocols](server-service-boundaries.md)
- [Frontend runtime ownership and recovery](frontend-agent-runtime.md)
- [Development verification](development-quality.md)
- [Dependency patch maintenance](../patches/README.md)
- [Runtime implementation](agent-core-runtime-implementation.md)
- [Communication implementation](agent-core-communication-implementation.md)
- [Session conversion](agent-core-session-conversion.md)
- [Performance baselines](performance/)
- [RFCs](rfcs/) — proposals for architectural decisions
- [Development records](archive/) — historical PRDs, handoffs and validation notes

Keep documentation describing supported behavior in the main directory. Put
one-off implementation plans and handoffs in `archive/`; do not treat a PRD or
an old validation transcript as proof of the current implementation.
