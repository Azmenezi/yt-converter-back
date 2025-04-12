import torchaudio
torchaudio.set_audio_backend("soundfile")  # or "sox_io"

import sys
import subprocess

# Forward command-line args to Demucs
cmd = ["demucs"] + sys.argv[1:]
subprocess.run(cmd, check=True)
