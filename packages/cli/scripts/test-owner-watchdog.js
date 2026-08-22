#!/usr/bin/env node

import { spawn } from 'node:child_process';

const OWNER_CHECK_INTERVAL_MS = 500;
const TERMINATION_GRACE_MS = 500;

function parsePid(value, label) {
  if (!/^[1-9]\d*$/.test(value ?? '')) {
    throw new Error(`Invalid ${label}`);
  }
  const pid = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Invalid ${label}`);
  }
  return pid;
}

const ownerPid = parsePid(process.argv[2], 'owner PID');
const targetPid = parsePid(process.argv[3], 'target PID');
let completed = false;
let terminating = false;
let input = '';

function signalTarget(signal) {
  if (process.platform === 'win32') {
    const args = ['/PID', String(targetPid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    spawn('taskkill', args, { detached: false, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  try {
    process.kill(-targetPid, signal);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') throw error;
  }
}

function terminateTarget() {
  if (completed || terminating) return;
  terminating = true;
  signalTarget('SIGTERM');
  setTimeout(() => {
    signalTarget('SIGKILL');
    process.exit(0);
  }, TERMINATION_GRACE_MS).unref();
}

function ownerIsRunning() {
  if (process.platform !== 'win32' && process.ppid !== ownerPid) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input = `${input}${chunk}`.slice(-16);
  if (input.includes('done\n')) {
    completed = true;
    process.exit(0);
  }
});
process.stdin.on('end', terminateTarget);
process.stdin.on('error', terminateTarget);
process.stdin.resume();

setInterval(() => {
  if (!ownerIsRunning()) terminateTarget();
}, OWNER_CHECK_INTERVAL_MS);
