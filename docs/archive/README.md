# Archived deployment descriptors

These files are retained only for historical reference and rollback archaeology.
They are intentionally outside the repository root so accidental Blueprint Sync
cannot create duplicate Render web services or databases.

| File | Reason |
|---|---|
| `render.yaml.v1` | Obsolete V1 blueprint. The active Render service uses `rootDir=V2` and is deployed from `V2/Dockerfile`; this V1 file is not part of that build context. |
| `zeabur.json.bak` | Obsolete Zeabur deployment descriptor. Production now runs on Render; Zeabur runtime resources are stopped but retained for rollback. |

Do not rename either file back to the repository root without a new deployment
review and an explicit Blueprint/Render plan.
