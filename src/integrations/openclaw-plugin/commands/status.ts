export async function statusCommand(baseUrl: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    const data = await res.json() as any;
    return `agent-memory status: ${res.ok ? 'OK' : 'ERROR'}\nObservations: ${data.observations || 0}\nSummaries: ${data.summaries || 0}`;
  } catch {
    return 'agent-memory status: UNREACHABLE';
  }
}
