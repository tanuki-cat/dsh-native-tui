#!/usr/bin/env python3
"""Drive the dsh-native-tui profile through a real PTY and print the transcript."""
import os, pty, select, subprocess, sys, time

home = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.tmp', 'dsh-home')
env = dict(os.environ)
env['DSH_HOME'] = home
env['TERM'] = 'xterm-256color'
env['NO_COLOR'] = ''
master, slave = pty.openpty()
proc = subprocess.Popen(
    ['dsh', '--profile', 'tui'],
    stdin=slave, stdout=slave, stderr=slave,
    cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    env=env, close_fds=True, start_new_session=True,
)
os.close(slave)
out = bytearray()
start = time.time()
sent = False
while time.time() - start < 25:
    ready, _, _ = select.select([master], [], [], 0.2)
    if ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        out.extend(data)
        text = bytes(out).decode('utf-8', 'replace')
        if not sent and ('enter send' in text or 'DeepSeek Harness' in text):
            time.sleep(0.8)
            os.write(master, b'\x04')
            sent = True
    if proc.poll() is not None and not ready:
        break
if proc.poll() is None:
    try: os.write(master, b'\x04')
    except OSError: pass
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill()
while True:
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready: break
    try: data = os.read(master, 65536)
    except OSError: break
    if not data: break
    out.extend(data)
os.close(master)
text = bytes(out).decode('utf-8', 'replace')
print(text)
print('\n--- exit:', proc.returncode, '---')
sys.exit(0 if proc.returncode == 0 else 1)
