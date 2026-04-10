import { homedir } from 'os';
import { join } from 'path';
export const appRoot = process.env.LSD_HOME || process.env.GSD_HOME || join(homedir(), '.lsd');
export const agentDir = join(appRoot, 'agent');
export const sessionsDir = join(appRoot, 'sessions');
export const authFilePath = join(agentDir, 'auth.json');
