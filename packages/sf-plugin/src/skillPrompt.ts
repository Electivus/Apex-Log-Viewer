import { createInterface } from 'node:readline/promises';
import { agentIds, type SkillAgent } from './skillTargets.js';

export async function selectSkillAgents(
  detected: SkillAgent[],
  ask: (message: string) => Promise<string>
): Promise<SkillAgent[]> {
  const ordered = [...agentIds].sort((a, b) => Number(detected.includes(b)) - Number(detected.includes(a)));
  const menu = ordered
    .map((agent, index) => `  ${index + 1}. ${agent}${detected.includes(agent) ? ' (detected)' : ''}`)
    .join('\n');
  for (;;) {
    const answer = (
      await ask(`Choose agents for the bundled skill:\n${menu}\nNumbers separated by commas (empty cancels): `)
    ).trim();
    if (!answer) throw new Error('Skill installation cancelled; no files were written.');
    const values = answer.split(',').map(value => value.trim());
    if (values.every(value => /^[1-4]$/.test(value))) {
      return [...new Set(values.map(value => ordered[Number(value) - 1]!))];
    }
  }
}

export async function promptForSkillAgents(detected: SkillAgent[]): Promise<SkillAgent[]> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const abort = new AbortController();
  readline.once('SIGINT', () => abort.abort());
  readline.once('close', () => abort.abort());
  try {
    return await selectSkillAgents(detected, message => readline.question(message, { signal: abort.signal }));
  } catch (error) {
    if (abort.signal.aborted) throw new Error('Skill installation cancelled; no files were written.');
    throw error;
  } finally {
    readline.close();
  }
}
