import { parseSchema, type SessionRef, Type } from '@api/schemas';
import { type TeamSnapshot, TeamSnapshotSchema } from '@api/teamSchemas';
import { requestJson } from '@/lib/http';

const TeamSnapshotArraySchema = Type.Array(TeamSnapshotSchema);

export type { TeamSnapshot };

export const teamService = {
  list: async (ref: SessionRef): Promise<TeamSnapshot[]> => {
    const query = new URLSearchParams({
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
    });
    return parseSchema(
      TeamSnapshotArraySchema,
      await requestJson<unknown>(`/teams?${query.toString()}`)
    );
  },

  sendMessage: async (
    ref: SessionRef,
    teamName: string,
    to: string,
    message: string
  ): Promise<void> => {
    await requestJson(`/teams/${encodeURIComponent(teamName)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: ref.sessionId,
        projectPath: ref.projectPath,
        to,
        message,
      }),
    });
  },

  delete: async (ref: SessionRef, teamName: string): Promise<TeamSnapshot> => {
    const query = new URLSearchParams({
      sessionId: ref.sessionId,
      projectPath: ref.projectPath,
    });
    return TeamSnapshotSchema.parse(
      await requestJson<unknown>(
        `/teams/${encodeURIComponent(teamName)}?${query.toString()}`,
        { method: 'DELETE' }
      )
    );
  },
};
