# Filesystem is the database

Receipts (session records, transcripts, state) live as files on disk under `sessions/<repo>/<issue#>-<timestamp>/`; there is no database, no daemon-held state, and no server-side store in v1. `seraphim status` is a listing over this directory, and the post-v1 control plane (#12) reads the same files.

Why: the tool must be inspectable and self-hostable with zero operational surface; "status" is `ls`, diagnostics are `cat`, nothing auto-deletes. Machine-readability is guaranteed by zod-schema'd JSON, not by a database.

Recorded: 2026-09-22, during pre-implementation planning (issues #2, #3, #12).
