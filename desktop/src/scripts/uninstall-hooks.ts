import { detectIDEs, unregister } from '../shared/hooks-config';

function main(): void {
  const ides = detectIDEs();
  for (const ide of ides) {
    if (!ide.isRegistered) continue;
    const result = unregister(ide.type);
    if (result.success) {
      console.error(`[uninstall-hooks] ${ide.type}: ok`);
    } else {
      console.error(
        `[uninstall-hooks] ${ide.type}: ${result.message ?? 'failed'}`,
      );
    }
  }
  process.exit(0);
}

main();
