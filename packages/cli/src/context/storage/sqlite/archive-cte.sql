WITH RECURSIVE archive_members(
  source_kind, project_path, public_workspace_ref, session_id, archive_root_id,
  effective_archived_at, depth
) AS (
  SELECT source_kind, project_path, public_workspace_ref, session_id, session_id,
         archived_at, 0
  FROM sessions
  WHERE archived_at IS NOT NULL
  UNION ALL
  SELECT child.source_kind, child.project_path, child.public_workspace_ref,
         child.session_id, parent.archive_root_id, parent.effective_archived_at,
         parent.depth + 1
  FROM sessions child
  JOIN archive_members parent
    ON child.source_kind = parent.source_kind
   AND child.project_path = parent.project_path
   AND child.public_workspace_ref IS parent.public_workspace_ref
   AND child.parent_id = parent.session_id
  WHERE parent.depth < 128
),
ranked_archive AS (
  SELECT source_kind, project_path, public_workspace_ref, session_id,
         archive_root_id, effective_archived_at,
         ROW_NUMBER() OVER (
           PARTITION BY source_kind, project_path, public_workspace_ref, session_id
           ORDER BY depth ASC, archive_root_id ASC
         ) AS rank
  FROM archive_members
)