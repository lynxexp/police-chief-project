import subprocess
import sys
import os
import shutil
import stat
import contextlib

# Windows consoles often default to a legacy code page (e.g. cp1252) that can't
# encode emoji used in theme icons/status output (e.g. the stats-summary line in
# bot_startup_display.ready()); force UTF-8 so those prints don't crash and get
# silently misreported as unrelated errors by whatever caller's except-block
# happens to catch the UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Cap glibc malloc arenas before anything allocates: glibc keeps a per-thread
# arena and never frees it, so OCR across many to_thread workers grows RSS until
# a 512MB container OOM-kills the bot. Must be set before glibc inits, so re-exec
# once if unset (same PID). Pre-set it to override.
if sys.platform.startswith("linux") and "MALLOC_ARENA_MAX" not in os.environ:
    os.environ["MALLOC_ARENA_MAX"] = "2"
    os.environ.setdefault("MALLOC_TRIM_THRESHOLD_", "131072")
    try:
        from cogs import bot_startup_display as _startup
        _startup.phase_ok("Optimized memory allocation")
    except Exception:
        print("  Optimized memory allocation", flush=True)
    os.execv(sys.executable, [sys.executable, *sys.argv])


def _bootstrap_from_main_branch(zip_url):
    """Self-heal via a source zip, if the operator has opted in with BOT_BOOTSTRAP_URL.

    cogs/ ships alongside main.py, so a missing cogs/ directory almost
    always means an incomplete install (files not copied/extracted fully). This
    project doesn't ship with a hosted release feed to fetch from automatically.
    We never fetch a hardcoded URL; if
    the operator sets BOT_BOOTSTRAP_URL to their own source archive, we'll use it,
    otherwise we just explain what's wrong and stop.
    """
    if not zip_url:
        print("Bot files are missing: the 'cogs' directory could not be found next to main.py.")
        print("This looks like an incomplete install — re-download or re-clone this repository")
        print("and make sure the 'cogs' folder is present alongside main.py.")
        print("(If you maintain your own source archive, set BOT_BOOTSTRAP_URL to fetch from it.)")
        sys.exit(1)

    import urllib.request, zipfile, io
    print(f"Bot files missing — downloading source from {zip_url} ...")
    try:
        with urllib.request.urlopen(zip_url, timeout=600) as r:
            buf = io.BytesIO(r.read())
    except Exception as e:
        print(f"Download failed: {e}")
        print(f"Please download the source manually from:\n  {zip_url}")
        print("Extract everything into this folder and run main.py again.")
        sys.exit(1)

    staging = "bot-bootstrap-tmp"
    if os.path.exists(staging):
        shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    staging_root = os.path.realpath(staging)

    try:
        with zipfile.ZipFile(buf) as zf:
            for m in zf.namelist():
                parts = m.split("/", 1)
                if len(parts) < 2 or not parts[1]:
                    continue
                target = os.path.realpath(os.path.join(staging, parts[1]))
                if target != staging_root and not target.startswith(staging_root + os.sep):
                    raise RuntimeError(f"zip entry escapes staging dir: {m}")
                if m.endswith("/"):
                    os.makedirs(target, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target) or staging, exist_ok=True)
                    with zf.open(m) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
        # Extraction succeeded — flip staged tree into cwd
        for item in os.listdir(staging):
            src = os.path.join(staging, item)
            if os.path.isdir(src):
                shutil.copytree(src, item, dirs_exist_ok=True)
            else:
                shutil.copy2(src, item)
    except Exception as e:
        print(f"Extraction failed: {e}")
        print("Your existing files were not modified. Re-run main.py to retry.")
        sys.exit(1)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

try:
    from cogs import bot_startup_display as startup
    from cogs.bot_restart import is_container, restart_process
except ImportError:
    # cogs/ is missing (likely an incomplete install). There's no hosted release
    # feed to fall back to, so we only fetch a zip if the operator has
    # explicitly pointed BOT_BOOTSTRAP_URL at their own source archive.
    _bootstrap_from_main_branch(os.environ.get("BOT_BOOTSTRAP_URL"))
    print("Download complete. Restarting...")
    if sys.platform == "win32":
        sys.exit(0)  # .bat / user re-runs; os.execv on Windows can race with the launcher
    os.execv(sys.executable, [sys.executable] + sys.argv)

# Python version check
MIN_PYTHON = (3, 11)

if sys.version_info < MIN_PYTHON:
    startup.python_too_old(f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]}", f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
    sys.exit(1)

def is_ci_environment() -> bool:
    """Check if running in a CI environment"""
    ci_indicators = [
        'CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 
        'JENKINS_URL', 'TRAVIS', 'CIRCLECI', 'GITLAB_CI'
    ]
    return any(os.getenv(indicator) for indicator in ci_indicators)

def break_system_packages() -> bool:
    """Check if the user is certain about breaking system packages"""
    return "--break-system-packages" in sys.argv

def break_system_packages_arg() -> bool:
    return break_system_packages() and not should_skip_venv()

def _pip_env():
    """Env for pip subprocesses that puts pip's download/unpack temp on the
    working volume. Containers (e.g. Pterodactyl) often give /tmp a tiny tmpfs
    separate from the disk quota, so big wheels (opencv ~73MB) fail with
    'No space left on device' even when the real disk has room. --no-cache-dir
    only moves the cache, not this temp."""
    env = os.environ.copy()
    tmp = os.path.join(os.getcwd(), ".pip-tmp")
    try:
        os.makedirs(tmp, exist_ok=True)
        env["TMPDIR"] = tmp   # POSIX
        env["TEMP"] = tmp     # Windows
        env["TMP"] = tmp
    except Exception:
        pass  # fall back to the default temp dir
    return env

def should_skip_venv() -> bool:
    """Check if venv should be skipped"""
    
    if ("--no-venv" in sys.argv) and (sys.platform.startswith("linux")) and (not is_container()) and (not is_ci_environment()) and (not break_system_packages()):
        startup.error_box(
            "Virtual Environment Required",
            "On Linux, running without a virtual environment won't work unless you break system packages.",
            "Add --break-system-packages to confirm you understand the risks."
        )
        sys.exit(1)
    
    return '--no-venv' in sys.argv or is_container() or is_ci_environment()

# Handle venv setup
if sys.prefix == sys.base_prefix and not should_skip_venv():
    venv_path = "bot_venv"

    # Determine the python executable path in the venv
    if sys.platform == "win32":
        venv_python_name = os.path.join(venv_path, "Scripts", "python.exe")
        activate_script = os.path.join(venv_path, "Scripts", "activate.bat")
    else:
        venv_python_name = os.path.join(venv_path, "bin", "python")
        activate_script = os.path.join(venv_path, "bin", "activate")

    if not os.path.exists(venv_path):
        try:
            startup.phase_start("Setting up virtual environment")
            subprocess.check_call([sys.executable, "-m", "venv", venv_path], timeout=300)

            # 3.12+ venvs seed only pip; source builds need setuptools.
            try:
                subprocess.run([venv_python_name, "-m", "pip", "install", "--upgrade",
                                "setuptools", "wheel"], timeout=300,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass

            if sys.platform == "win32":
                startup.venv_instructions(venv_python_name, sys.platform)
                sys.exit(0)
            else: # For non-Windows, try to relaunch automatically
                startup.venv_instructions(venv_python_name, sys.platform)
                venv_python_executable = os.path.join(venv_path, "bin", "python")
                os.execv(venv_python_executable, [venv_python_executable] + sys.argv)

        except Exception as e:
            startup.error_box("Virtual Environment Failed", str(e), "python -m venv bot_venv")
            sys.exit(1)
    else: # Venv exists
        if sys.platform == "win32":
            startup.venv_exists_instructions(venv_python_name, sys.platform)
            sys.exit(0)
        elif '--no-venv' in sys.argv:
            pass  # Silent, not important
        else: # For non-Windows, if venv exists but we're not in it, try to relaunch
            venv_python_executable = os.path.join(venv_path, "bin", "python")
            if os.path.exists(venv_python_executable):
                os.execv(venv_python_executable, [venv_python_executable] + sys.argv)
            else:
                startup.error_box("Virtual Environment Corrupted", "Please delete bot_venv and run again.")
                sys.exit(1)

try: # Import or install requests so we can get the requirements
    import requests
except ImportError:
    try:
        cmd = [sys.executable, "-m", "pip", "install", "requests"]

        if break_system_packages_arg():
            cmd.append("--break-system-packages")

        subprocess.check_call(cmd, timeout=300, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import requests
    except Exception as e:
        startup.error_box("Dependency Error", f"Failed to install requests: {e}", "pip install requests")
        sys.exit(1)

def remove_readonly(func, path, _):
    """Clear the readonly bit and reattempt the removal"""
    os.chmod(path, stat.S_IWRITE)
    func(path)

def safe_remove(path, is_dir=None):
    """
    Safely remove a file or directory.
    Clear the read-only bit on Windows.
    
    Args:
        path: Path to file or directory to remove
        is_dir: True for directory, False for file, None to auto-detect
        
    Returns:
        bool: True if successfully removed, False otherwise
    """
    if not os.path.exists(path):
        return True  # Already gone, consider it success
    
    if is_dir is None: # Auto-detect type if not specified
        is_dir = os.path.isdir(path)
    
    try:
        if is_dir:
            if sys.platform == "win32":
                if sys.version_info >= (3, 12): # check if python version >= 3.12 for onexc support
                    shutil.rmtree(path, onexc=remove_readonly)
                else:
                    shutil.rmtree(path, onerror=remove_readonly)
            else:
                shutil.rmtree(path)
        else:
            try:
                os.remove(path)
            except PermissionError:
                if sys.platform == "win32":
                    os.chmod(path, stat.S_IWRITE)
                    os.remove(path)
                else:
                    raise  # Re-raise on non-Windows platforms
        
        return True
        
    except PermissionError:
        print(f"Warning: Access Denied. Could not remove '{path}'.\nCheck permissions or if {'directory' if is_dir else 'file'} is in use.")
    except OSError as e:
        print(f"Warning: Could not remove '{path}': {e}")
    
    return False

def _requirement_name(spec):
    """Extract the bare package name from a requirements.txt line/spec."""
    for sep in ("==", ">=", "<=", "~=", "!="):
        spec = spec.split(sep)[0]
    return spec


# OCR-only: the bot boots fine without these (OCR just switches off) if they won't install.
OPTIONAL_PACKAGES = {"onnxruntime", "rapidocr"}


def _pip_install_one(package, *, retries=1):
    """Install one requirement, retrying once for transient failures. Returns (ok, output_tail)."""
    import time
    cmd = [sys.executable, "-m", "pip", "install", package, "--no-cache-dir"]
    if break_system_packages_arg():
        cmd.append("--break-system-packages")
    tail = []
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(3)  # give a transient lock a moment to clear before retrying
        try:
            result = subprocess.run(cmd, timeout=1200, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, env=_pip_env())
            if result.returncode == 0:
                return True, []
            tail = (result.stdout or "").strip().splitlines()[-15:]
        except Exception as e:
            tail = [str(e)]
    return False, tail


def check_and_install_requirements():
    """Check each requirement and install missing ones."""
    if not os.path.exists("requirements.txt"):
        return False

    # Read requirements
    with open("requirements.txt", "r") as f:
        requirements = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    
    missing_packages = []
    
    # Test each requirement
    for requirement in requirements:
        package_name = _requirement_name(requirement)

        try:
            if package_name == "discord.py":
                import discord
            elif package_name == "aiohttp-socks":
                import aiohttp_socks
            elif package_name == "python-dotenv":
                import dotenv
            elif package_name == "python-bidi":
                import bidi
            elif package_name == "arabic-reshaper":
                import arabic_reshaper
            elif package_name.lower() == "pillow":
                import PIL
            elif package_name.lower() == "numpy":
                import numpy
            else:
                __import__(package_name)

        except ImportError:
            missing_packages.append(requirement)

    if missing_packages: # Install missing packages
        startup.phase_start("Installing missing packages")
        for package in missing_packages:
            ok, tail = _pip_install_one(package)
            if ok:
                continue
            if _requirement_name(package).lower() in OPTIONAL_PACKAGES:
                startup.warn(f"Could not install {_requirement_name(package)} - screenshot reading (OCR) "
                             f"will be off. Everything else works. "
                             f"Set an External OCR Service under Vault Trap Tracking to re-enable it.")
                continue
            startup.phase_fail("Dependencies failed",
                               details=[f"Failed to install {package}:", *tail],
                               fix="pip install -r requirements.txt")
            return False

    startup.phase_ok("Dependencies satisfied")
    return True

def ensure_opencv_headless():
    """RapidOCR pulls in the full `opencv-python`, whose cv2 needs system GUI
    libs (libGL.so.1) that headless servers lack — which silently disables OCR.
    Swap to `opencv-python-headless`, which the bot's image processing uses fine
    and needs no system libs. No-op once only the headless build is present."""
    try:
        from importlib.metadata import distributions
        installed = {(d.metadata.get("Name") or "").lower().replace("_", "-")
                     for d in distributions()}
    except Exception:
        return
    if not ({"opencv-python", "opencv-contrib-python"} & installed):
        return  # already headless-only (or no opencv) — nothing to do
    startup.phase_start("Switching OpenCV to headless")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "uninstall", "-y",
             "opencv-python", "opencv-contrib-python", "opencv-python-headless"],
            timeout=600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", "opencv-python-headless"]
        if break_system_packages_arg():
            cmd.append("--break-system-packages")
        subprocess.check_call(cmd, timeout=1200, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=_pip_env())
        startup.phase_ok("OpenCV set to headless")
    except Exception as e:
        startup.phase_fail(
            "OpenCV headless switch failed", details=[str(e)],
            fix="pip uninstall -y opencv-python opencv-contrib-python && pip install opencv-python-headless",
        )


def setup_dependencies():
    """Main function to set up all dependencies."""
    startup.phase_start("Checking dependencies")

    if not os.path.exists("requirements.txt"):
        startup.phase_fail(
            "Dependencies failed",
            details=["requirements.txt is missing"],
            fix="Re-download or re-clone this repository so requirements.txt is present alongside main.py",
        )
        return False

    if not check_and_install_requirements():
        startup.phase_fail("Dependencies failed", fix="pip install -r requirements.txt")
        return False

    ensure_opencv_headless()
    return True

setup_dependencies()  # Warnings shown internally on failure

try:
    from colorama import Fore, Style, init
    import discord
except ImportError as e:
    startup.error_box("Import Failed", f"Import failed after dependency setup: {e}", "Restart the script or run: pip install -r requirements.txt")
    sys.exit(1)

# Colorama shortcuts
F = Fore
R = Style.RESET_ALL

import warnings
import aiohttp

def check_vcredist():
    """Check if Visual C++ Redistributable is installed on Windows."""
    if sys.platform != "win32":
        return True  # Not applicable on non-Windows

    try:
        import winreg
        import struct

        # Determine Python architecture
        is_64bit = struct.calcsize("P") * 8 == 64
        arch = "x64" if is_64bit else "x86"

        # Registry key for VC++ 2015-2022 runtime
        key_path = f"SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\{arch}"

        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path)
            winreg.CloseKey(key)
            return True  # VC++ Redist is installed
        except FileNotFoundError:
            # VC++ Redist not found - show warning
            download_url = f"https://aka.ms/vc14/vc_redist.{arch}.exe"
            startup.phase_fail(f"Visual C++ Redistributable ({arch}) not found",
                details=["Gift code redemption (captcha solver) will not work until this is installed."],
                fix=f"Download from: {download_url}")
            return False

    except Exception:
        return True  # If we can't check, we hope it's fine

check_vcredist()

warnings.filterwarnings("ignore", category=DeprecationWarning)

init(autoreset=True)

try:
    import ssl
    import certifi

    def _create_ssl_context_with_certifi():
        return ssl.create_default_context(cafile=certifi.where())
    
    original_create_default_https_context = getattr(ssl, "_create_default_https_context", None)

    if original_create_default_https_context is None or \
       original_create_default_https_context is ssl.create_default_context:
        ssl._create_default_https_context = _create_ssl_context_with_certifi
    # else: already patched elsewhere, leave it alone
except ImportError:
    pass  # Certifi not found, SSL verification might fail
except Exception:
    pass  # SSL patch error, continue anyway

def raise_open_file_limit(floor=1024, target=4096):
    """Raise a too-low FD limit (macOS defaults to 256) so SQLite can't fail with 'unable to open database file'. No-op on Windows and on already-healthy limits (>=floor)."""
    try:
        import resource
    except ImportError:
        return  # Windows has no RLIMIT_NOFILE
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    except Exception:
        return
    if soft == resource.RLIM_INFINITY or soft >= floor:
        return  # already comfortable - don't touch healthy limits
    ceiling = target if hard == resource.RLIM_INFINITY else min(target, hard)
    new_soft = soft
    for candidate in (ceiling, 2048, 1024):
        if candidate <= soft:
            break
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (candidate, hard))
            new_soft = candidate
            break
        except (ValueError, OSError):
            continue
    if new_soft > soft:
        startup.info(f"Raised open-file limit {soft} -> {new_soft} (macOS default 256 is too low).")
    if new_soft < floor:
        startup.warn(
            f"Open-file limit is only {new_soft}, which can make the database "
            "intermittently unreadable. Start the bot from a terminal after: ulimit -n 4096"
        )


if __name__ == "__main__":
    # ── Proxy support (--proxy flag) ───────────────────────────────────────────
    # Pass --proxy <url> to route all game API traffic through a proxy server.
    # Example: python main.py --proxy http://192.168.1.10:18080
    # If --proxy is passed without a URL, defaults to http://localhost:18080.
    # This is required when running behind proxysolution-network.
    _proxy_url = None
    if "--proxy" in sys.argv:
        _proxy_idx = sys.argv.index("--proxy")
        _proxy_url = (
            sys.argv[_proxy_idx + 1]
            if _proxy_idx + 1 < len(sys.argv) and not sys.argv[_proxy_idx + 1].startswith("--")
            else "http://localhost:18080"
        )
        os.environ.setdefault("HTTP_PROXY",  _proxy_url)
        os.environ.setdefault("HTTPS_PROXY", _proxy_url)
        os.environ.setdefault("http_proxy",  _proxy_url)
        os.environ.setdefault("https_proxy", _proxy_url)

    # Display startup header
    _version = "unknown"
    if os.path.exists("version"):
        # utf-8-sig strips a leading UTF-8 BOM if present (e.g. from a
        # Windows editor or PowerShell's -Encoding utf8, which always
        # writes one) -- reads identically to plain utf-8 when there
        # isn't one, so this is safe either way.
        with open("version", "r", encoding="utf-8-sig") as f:
            _version = f.read().strip()
    _flags = []
    if '--no-venv' in sys.argv: _flags.append('--no-venv')
    if '--no-dm' in sys.argv: _flags.append('--no-dm')
    if '--break-system-packages' in sys.argv: _flags.append('--break-system-packages')
    if _proxy_url: _flags.append('--proxy')
    startup.header(_version, f"{sys.version_info.major}.{sys.version_info.minor}", _flags or None)
    if _proxy_url:
        startup.info(f"Routing player traffic through proxy: {_proxy_url}")

    import asyncio
    import discord
    from discord.ext import commands
    import sqlite3
    import logging
    import logging.handlers

    def setup_logging():
        """Configure centralized logging with category-based file handlers."""
        log_dir = 'log'
        os.makedirs(log_dir, exist_ok=True)

        # Common formatter
        formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        simple_formatter = logging.Formatter('%(asctime)s - %(message)s')

        # Category mappings: logger name prefix -> log file
        categories = {
            'alliance': 'alliance.txt',
            'gift': 'gift.txt',
            'redemption': 'redemption.txt',
            'notification': 'notification.txt',
            'bot': 'bot.txt',
        }

        # Create rotating file handlers for each category
        handlers = {}
        for category, filename in categories.items():
            handler = logging.handlers.RotatingFileHandler(
                os.path.join(log_dir, filename),
                maxBytes=2 * 1024 * 1024,  # 2MB
                backupCount=1,
                encoding='utf-8'
            )
            # Use simple formatter for redemption log
            if category == 'redemption':
                handler.setFormatter(simple_formatter)
            else:
                handler.setFormatter(formatter)
            handler.setLevel(logging.INFO)
            handlers[category] = handler

        # Configure loggers for each category
        for category, handler in handlers.items():
            logger = logging.getLogger(category)
            logger.setLevel(logging.INFO)
            logger.propagate = False
            if not logger.hasHandlers():
                logger.addHandler(handler)

        # Configure root logger with console output only
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.ERROR)  # Only show errors on console

    setup_logging()

    # Silence tqdm progress bars (RapidOCR's model downloads emit them
    # straight to stderr, which logging can't intercept).
    os.environ.setdefault('TQDM_DISABLE', '1')

    # Route RapidOCR / onnxruntime chatter to log/rapidocr.txt instead of
    # the console. Those libraries attach their own StreamHandlers at
    # import time, which bypass propagate/level on the parent logger;
    # we have to clear those handlers explicitly before attaching ours.
    rapidocr_log_path = os.path.join('log', 'rapidocr.txt')
    rapidocr_handler = logging.handlers.RotatingFileHandler(
        rapidocr_log_path, maxBytes=2 * 1024 * 1024, backupCount=1, encoding='utf-8',
    )
    rapidocr_handler.setFormatter(
        logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    )
    rapidocr_handler.setLevel(logging.INFO)
    for noisy_logger in ['RapidOCR', 'rapidocr', 'rapidocr.main', 'rapidocr.base',
                         'rapidocr.download_file', 'onnxruntime']:
        _noisy = logging.getLogger(noisy_logger)
        for h in list(_noisy.handlers):
            _noisy.removeHandler(h)
        _noisy.setLevel(logging.INFO)
        _noisy.propagate = False
        _noisy.addHandler(rapidocr_handler)

    # Stdout filter: redirect tagged print() calls from cogs to log files
    class _ConsoleFilter:
        PATTERNS = ['[ERROR]', '[WARNING]', '[INFO]', '[SYNC]', '[ORPHAN CHECK]',
                    '[AUTO-DISABLE]', '[MONITOR]', '[RapidOCR]']

        def __init__(self, original):
            self._original = original
            self._logger = logging.getLogger('bot')

        def write(self, text):
            stripped = text.strip()
            if stripped and any(stripped.startswith(p) for p in self.PATTERNS):
                self._logger.info(stripped)
            else:
                self._original.write(text)

        def flush(self):
            self._original.flush()

        def __getattr__(self, name):
            return getattr(self._original, name)

    sys.stdout = _ConsoleFilter(sys.stdout)

    class CustomBot(commands.Bot):
        no_dm: bool = False

        async def on_error(self, event_name, *args, **kwargs):
            if event_name == "on_interaction":
                error = sys.exc_info()[1]
                if isinstance(error, discord.NotFound) and error.code == 10062:
                    return
            
            await super().on_error(event_name, *args, **kwargs)

        async def on_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
            if isinstance(error, discord.NotFound) and error.code == 10062:
                return
            await super().on_command_error(ctx, error)

    intents = discord.Intents.default()
    intents.message_content = True
    # Privileged intent, required for on_member_join (the registration
    # welcome-DM listener in alliance_registration.py) to fire at all --
    # must also be turned on in the Discord Developer Portal under
    # Bot -> Privileged Gateway Intents -> Server Members Intent, or
    # login fails with discord.PrivilegedIntentsRequired (handled below).
    intents.members = True

    bot = CustomBot(command_prefix="/", intents=intents)
    bot.no_dm = '--no-dm' in sys.argv

    token_file = "bot_token.txt"
    if not os.path.exists(token_file):
        bot_token = input("Enter the bot token: ")
        with open(token_file, "w") as f:
            f.write(bot_token)
    else:
        with open(token_file, "r") as f:
            bot_token = f.read().strip()

    if not os.path.exists("db"):
        os.makedirs("db")

    databases = {
        "conn_alliance": "db/alliance.sqlite",
        "conn_giftcode": "db/giftcode.sqlite",
        "conn_changes": "db/changes.sqlite",
        "conn_users": "db/users.sqlite",
        "conn_settings": "db/settings.sqlite",
        "conn_id_channel": "db/id_channel.sqlite",
    }

    connections = {name: sqlite3.connect(path) for name, path in databases.items()}

    def create_tables():
        with connections["conn_changes"] as conn_changes:
            conn_changes.execute("""CREATE TABLE IF NOT EXISTS nickname_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                fid INTEGER, 
                old_nickname TEXT, 
                new_nickname TEXT, 
                change_date TEXT
            )""")
            
            conn_changes.execute("""CREATE TABLE IF NOT EXISTS chief_office_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fid INTEGER,
                old_chief_office_lv INTEGER,
                new_chief_office_lv INTEGER,
                change_date TEXT
            )""")

        with connections["conn_settings"] as conn_settings:
            conn_settings.execute("""CREATE TABLE IF NOT EXISTS botsettings (
                id INTEGER PRIMARY KEY,
                channelid INTEGER,
                giftcodestatus TEXT
            )""")

            conn_settings.execute("""CREATE TABLE IF NOT EXISTS bot_global_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT
            )""")

            conn_settings.execute("""CREATE TABLE IF NOT EXISTS admin (
                id INTEGER PRIMARY KEY,
                is_initial INTEGER
            )""")

            conn_settings.execute("""CREATE TABLE IF NOT EXISTS process_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                priority INTEGER NOT NULL,
                alliance_id INTEGER,
                details TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                completed_at TEXT
            )""")
            conn_settings.execute("""CREATE INDEX IF NOT EXISTS idx_process_queue_status_priority
                ON process_queue(status, priority, id)""")

            conn_settings.execute("""CREATE TABLE IF NOT EXISTS ocr_channel_settings (
                channel_id INTEGER PRIMARY KEY,
                alliance_id INTEGER NOT NULL,
                post_info_message INTEGER DEFAULT 1,
                pin_info_message INTEGER DEFAULT 1,
                info_message_id INTEGER,
                auto_delete_screenshots INTEGER DEFAULT 1
            )""")
            try:
                conn_settings.execute("SELECT auto_delete_screenshots FROM ocr_channel_settings LIMIT 1")
            except sqlite3.OperationalError:
                conn_settings.execute(
                    "ALTER TABLE ocr_channel_settings ADD COLUMN auto_delete_screenshots INTEGER DEFAULT 1"
                )
            conn_settings.execute("""CREATE TABLE IF NOT EXISTS ocr_channel_event_keywords (
                channel_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                keyword TEXT NOT NULL,
                PRIMARY KEY (channel_id, event_type, keyword)
            )""")
            conn_settings.execute("""CREATE INDEX IF NOT EXISTS idx_ocr_keywords_channel
                ON ocr_channel_event_keywords(channel_id)""")

            # Explicit "event enabled on this channel" registry, decoupled
            # from keywords so an admin can enable an event with zero keywords
            # and let the fingerprint regex classify it on its own.
            conn_settings.execute("""CREATE TABLE IF NOT EXISTS ocr_channel_enabled_events (
                channel_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                PRIMARY KEY (channel_id, event_type)
            )""")
            conn_settings.execute("""CREATE INDEX IF NOT EXISTS idx_ocr_enabled_channel
                ON ocr_channel_enabled_events(channel_id)""")
            # One-time backfill: every (channel, event) that already has keywords
            # is now also marked explicitly enabled. Idempotent.
            conn_settings.execute("""INSERT OR IGNORE INTO ocr_channel_enabled_events
                (channel_id, event_type)
                SELECT DISTINCT channel_id, event_type FROM ocr_channel_event_keywords""")

            conn_settings.execute("""CREATE TABLE IF NOT EXISTS permission_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                target_id INTEGER NOT NULL,
                before_state TEXT,
                after_state TEXT,
                timestamp TEXT NOT NULL
            )""")
            conn_settings.execute("""CREATE INDEX IF NOT EXISTS idx_permission_audit_timestamp
                ON permission_audit_log(timestamp DESC)""")

            # Per-alliance opt-in channel summary posted after each redemption.
            # No row = disabled (default). Buckets choose what the summary lists.
            conn_settings.execute("""CREATE TABLE IF NOT EXISTS redemption_summary_settings (
                alliance_id INTEGER PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 0,
                show_success INTEGER NOT NULL DEFAULT 0,
                show_already INTEGER NOT NULL DEFAULT 0,
                show_failed INTEGER NOT NULL DEFAULT 1
            )""")

        with connections["conn_users"] as conn_users:
            conn_users.execute("""CREATE TABLE IF NOT EXISTS users (
                fid INTEGER PRIMARY KEY,
                nickname TEXT,
                chief_office_lv INTEGER,
                kid INTEGER,
                alliance TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                deactivated_at TEXT
            )""")
            _users_columns_to_add = [
                ("power",                   "INTEGER"),
                ("power_updated_at",        "TEXT"),
                ("combat_power",            "INTEGER"),
                ("combat_power_updated_at", "TEXT"),
                ("discord_id",              "INTEGER"),
                ("discord_server_id",       "INTEGER"),
                ("discord_id_updated_at",   "TEXT"),
                ("state_mismatch_at",       "TEXT"),
                # Police Chief's HQ building ("Chief's Office"), plain integer 1-45.
                # Migration guard in case an existing DB predates this column.
                ("chief_office_lv",         "INTEGER"),
                # Soft-delete: "Remove Members" deactivates instead of deleting, so
                # trap/attendance history survives. Reactivated on re-register/re-add.
                ("is_active",               "INTEGER NOT NULL DEFAULT 1"),
                ("deactivated_at",          "TEXT"),
            ]
            for _col, _typ in _users_columns_to_add:
                try:
                    conn_users.execute(f"SELECT {_col} FROM users LIMIT 1")
                except sqlite3.OperationalError:
                    conn_users.execute(f"ALTER TABLE users ADD COLUMN {_col} {_typ}")
            conn_users.execute(
                "CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id)"
            )

        with connections["conn_giftcode"] as conn_giftcode:
            conn_giftcode.execute("""CREATE TABLE IF NOT EXISTS gift_codes (
                giftcode TEXT PRIMARY KEY, 
                date TEXT
            )""")
            
            conn_giftcode.execute("""CREATE TABLE IF NOT EXISTS user_giftcodes (
                fid INTEGER,
                giftcode TEXT,
                status TEXT,
                last_attempt_at TEXT,
                PRIMARY KEY (fid, giftcode),
                FOREIGN KEY (giftcode) REFERENCES gift_codes (giftcode)
            )""")
            # Upgrade path: per-account attempt timestamp for the redeem-results viewer.
            uc_cols = [row[1] for row in conn_giftcode.execute("PRAGMA table_info(user_giftcodes)").fetchall()]
            if "last_attempt_at" not in uc_cols:
                conn_giftcode.execute("ALTER TABLE user_giftcodes ADD COLUMN last_attempt_at TEXT")

        with connections["conn_id_channel"] as conn_id_channel:
            conn_id_channel.execute("""CREATE TABLE IF NOT EXISTS id_channels (
                guild_id INTEGER,
                alliance_id INTEGER,
                channel_id INTEGER,
                created_at TEXT,
                created_by INTEGER,
                UNIQUE(guild_id, channel_id)
            )""")
            # Tracks the standing info message so it can be edited instead of reposted.
            _idc_cols = {r[1] for r in conn_id_channel.execute("PRAGMA table_info(id_channels)")}
            if "info_message_id" not in _idc_cols:
                conn_id_channel.execute("ALTER TABLE id_channels ADD COLUMN info_message_id INTEGER")

        with connections["conn_alliance"] as conn_alliance:
            conn_alliance.execute("""CREATE TABLE IF NOT EXISTS alliancesettings (
                alliance_id INTEGER PRIMARY KEY,
                channel_id INTEGER,
                interval INTEGER
            )""")

            # Per-alliance toggle: auto-remove a member detected (at gift redemption)
            # to have left this single-state alliance's state. Off by default.
            try:
                conn_alliance.execute("SELECT auto_remove_on_transfer FROM alliancesettings LIMIT 1")
            except sqlite3.OperationalError:
                conn_alliance.execute(
                    "ALTER TABLE alliancesettings ADD COLUMN auto_remove_on_transfer INTEGER DEFAULT 0"
                )

            # Per-alliance ID channel info message: post it, and pin it. Posting is
            # off by default so an update never writes into an existing channel.
            for _col, _default in (("id_post_info_message", "0"), ("id_pin_info_message", "1")):
                try:
                    conn_alliance.execute(f"SELECT {_col} FROM alliancesettings LIMIT 1")
                except sqlite3.OperationalError:
                    conn_alliance.execute(
                        f"ALTER TABLE alliancesettings ADD COLUMN {_col} INTEGER DEFAULT {_default}"
                    )

            # Per-alliance gate for who can upload screenshots in the
            # Screenshot Upload channels (0 = anyone, 1 = bot admins only).
            try:
                conn_alliance.execute("SELECT ocr_upload_admin_only FROM alliancesettings LIMIT 1")
            except sqlite3.OperationalError:
                conn_alliance.execute(
                    "ALTER TABLE alliancesettings ADD COLUMN ocr_upload_admin_only INTEGER DEFAULT 0"
                )

            # Per-alliance toggle for @silent sync posts (0 = ring, 1 = no notification ping).
            try:
                conn_alliance.execute("SELECT silent_notifications FROM alliancesettings LIMIT 1")
            except sqlite3.OperationalError:
                conn_alliance.execute(
                    "ALTER TABLE alliancesettings ADD COLUMN silent_notifications INTEGER DEFAULT 0"
                )

            # Dedicated gift-redemption progress channel
            try:
                conn_alliance.execute("SELECT redemption_channel_id FROM alliancesettings LIMIT 1")
            except sqlite3.OperationalError:
                conn_alliance.execute(
                    "ALTER TABLE alliancesettings ADD COLUMN redemption_channel_id INTEGER"
                )
                conn_alliance.execute(
                    "UPDATE alliancesettings SET redemption_channel_id = channel_id"
                )

            # Sync Log is gone - inherit it as the redemption log, once only.
            with connections["conn_settings"] as _cs:
                _cs.execute("""CREATE TABLE IF NOT EXISTS bot_global_settings (
                    setting_key TEXT PRIMARY KEY, setting_value TEXT)""")
                _done = _cs.execute(
                    "SELECT 1 FROM bot_global_settings WHERE setting_key = 'sync_log_migrated'"
                ).fetchone()
            if not _done:
                conn_alliance.execute(
                    "UPDATE alliancesettings SET redemption_channel_id = channel_id "
                    "WHERE redemption_channel_id IS NULL AND channel_id IS NOT NULL"
                )
                with connections["conn_settings"] as _cs:
                    _cs.execute(
                        "INSERT OR REPLACE INTO bot_global_settings VALUES ('sync_log_migrated', '1')"
                    )

            # Fallback to giftcode channel for upgrades from v1.x which posted redemption progress there
            with connections["conn_settings"] as _cs:
                _giftfb_done = _cs.execute(
                    "SELECT 1 FROM bot_global_settings WHERE setting_key = 'redeem_channel_gift_fallback'"
                ).fetchone()
            if not _giftfb_done:
                try:
                    _gift_channels = connections["conn_giftcode"].execute(
                        "SELECT alliance_id, channel_id FROM giftcode_channel WHERE channel_id IS NOT NULL"
                    ).fetchall()
                except sqlite3.OperationalError:
                    _gift_channels = []   # table absent on a fresh install
                for _aid, _cid in _gift_channels:
                    conn_alliance.execute(
                        "UPDATE alliancesettings SET redemption_channel_id = ? "
                        "WHERE alliance_id = ? AND redemption_channel_id IS NULL",
                        (_cid, _aid),
                    )
                with connections["conn_settings"] as _cs:
                    _cs.execute(
                        "INSERT OR REPLACE INTO bot_global_settings VALUES ('redeem_channel_gift_fallback', '1')"
                    )

            conn_alliance.execute("""CREATE TABLE IF NOT EXISTS alliance_list (
                alliance_id INTEGER PRIMARY KEY,
                name TEXT,
                discord_server_id INTEGER,
                kid INTEGER
            )""")
            # Upgrade path: ensure discord_server_id exists before any cog queries it.
            existing_cols = [row[1] for row in conn_alliance.execute("PRAGMA table_info(alliance_list)").fetchall()]
            if "discord_server_id" not in existing_cols:
                conn_alliance.execute("ALTER TABLE alliance_list ADD COLUMN discord_server_id INTEGER")
            # Upgrade path: per-alliance state lock. NULL = no restriction (legacy behaviour).
            if "kid" not in existing_cols:
                conn_alliance.execute("ALTER TABLE alliance_list ADD COLUMN kid INTEGER")
            # Upgrade path: multistate flag - members span many states, never auto-bind to one.
            if "multistate" not in existing_cols:
                conn_alliance.execute("ALTER TABLE alliance_list ADD COLUMN multistate INTEGER DEFAULT 0")
            # Upgrade path: separate the deliberate state-lock from the (auto-bindable) home state.
            # Any alliance that already had a kid set was an intentional lock -> preserve it.
            if "state_locked" not in existing_cols:
                conn_alliance.execute("ALTER TABLE alliance_list ADD COLUMN state_locked INTEGER DEFAULT 0")
                conn_alliance.execute("UPDATE alliance_list SET state_locked = 1 WHERE kid IS NOT NULL")
            # Upgrade path: 3-char alliance short tag (e.g. "APX"), used to filter
            # Capitol War's state-wide "Honor Roll" rows down to just this alliance
            # before roster matching -- see docs/ocr-reference/capitol_war.md.
            if "tag" not in existing_cols:
                conn_alliance.execute("ALTER TABLE alliance_list ADD COLUMN tag TEXT")

            # Web dashboard's alliance-goal panel: one live row per alliance
            # per cycle. Progress is never stored here -- it's summed from
            # the alliance's own vault/capitol session data at read time, so
            # it can never disagree with the leaderboard (see
            # webapp/backend/src/routes/member.ts's alliance-goal route).
            conn_alliance.execute("""CREATE TABLE IF NOT EXISTS alliance_goals (
                alliance_id INTEGER PRIMARY KEY,
                metric TEXT NOT NULL,
                target INTEGER NOT NULL,
                cycle_kind TEXT NOT NULL,
                starts_on TEXT NOT NULL,
                ends_on TEXT,
                repeats INTEGER DEFAULT 0,
                visibility TEXT DEFAULT 'everyone',
                created_by INTEGER,
                created_at TEXT
            )""")

    raise_open_file_limit()
    create_tables()
    startup.phase_ok("Database ready")

    async def load_cogs():
        cogs = ["pimp_my_bot", "process_queue", "onnx_lifecycle", "bot_main_menu", "alliance", "alliance_member_operations", "bot_operations", "alliance_logs", "bot_support", "bot_health", "gift_operations", "alliance_history", "alliance_w_command", "bot_startup", "notification_system", "notification_schedule", "alliance_id_channel", "alliance_channels", "bot_backup", "notification_editor", "notification_wizard", "attendance", "attendance_report", "attendance_ocr", "minister_schedule", "minister_menu", "minister_archive", "alliance_registration", "vault_track", "capitol_war", "help"]

        failed_cogs = []

        # Suppress all console output during cog loading to prevent
        # third-party libraries (RapidOCR, onnxruntime) from spamming.
        logging.disable(logging.INFO)
        with open(os.devnull, 'w') as devnull, \
                contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
            for cog in cogs:
                try:
                    await bot.load_extension(f"cogs.{cog}")
                except Exception as e:
                    failed_cogs.append((cog, str(e)))
        logging.disable(logging.NOTSET)

        total = len(cogs)
        loaded = total - len(failed_cogs)
        if failed_cogs:
            startup.phase_fail(
                f"{loaded}/{total} modules loaded",
                details=[f"{cog}: {error}" for cog, error in failed_cogs],
                fix="Check that all files in the cogs/ folder are present and reinstall dependencies: pip install -r requirements.txt"
            )
        else:
            startup.phase_ok(f"{loaded}/{total} modules loaded")

    @bot.event
    async def on_ready():
        try:
            startup.phase_ok(f"Connected to Discord as {bot.user}")
            # Sync once per process — on_ready re-fires on reconnect; commands are static.
            if not getattr(bot, '_commands_synced', False):
                startup.phase_start("Syncing slash commands with Discord")
                await bot.tree.sync()
                bot._commands_synced = True
                startup.phase_ok("Slash commands synced with Discord")

            # API health checks
            try:
                import aiohttp as _aio
                # trust_env so HTTPS_PROXY is honored by the OCR check below.
                # Police Chief has no redemption/distribution API of its own
                # to probe here -- those aren't features this bot has.
                timeout = _aio.ClientTimeout(total=5)

                # OCR status.
                try:
                    from cogs.vault_track import remote_ocr_url, OCR_REMOTE_TOKEN
                    ocr_url = remote_ocr_url()
                    if not ocr_url:
                        startup.phase_ok("Using local OCR")
                    else:
                        startup.phase_start("Checking External OCR Service")
                        try:
                            async with _aio.ClientSession(timeout=timeout, trust_env=True) as ocr_session:
                                async with ocr_session.get(
                                    f"{ocr_url}/health",
                                    headers={"X-API-Key": OCR_REMOTE_TOKEN},
                                ) as resp:
                                    ok = resp.status == 200
                                    ocr_detail = None if ok else f"HTTP {resp.status}"
                            startup.api_status("External OCR Service", "ok" if ok else "error", ocr_detail)
                        except Exception:
                            startup.api_status("External OCR Service", "error", "Unreachable (using local OCR)")
                except Exception:
                    pass
            except Exception:
                pass

            # Summary with per-alliance breakdown
            alliance_details = []
            try:
                import sqlite3 as _sq
                with _sq.connect('db/alliance.sqlite') as _c:
                    alliances = _c.execute("SELECT alliance_id, name FROM alliance_list ORDER BY name").fetchall()
                    alliance_count = len(alliances)
                with _sq.connect('db/users.sqlite') as _c:
                    member_count = _c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
                    for aid, name in alliances:
                        count = _c.execute("SELECT COUNT(*) FROM users WHERE alliance = ?", (aid,)).fetchone()[0]
                        alliance_details.append((name, count))
            except Exception:
                alliance_count = 0
                member_count = 0

            startup.summary(len(bot.guilds), alliance_count, member_count, alliance_details or None)

            # Wait briefly for cog on_ready handlers to complete, then show DM status
            await asyncio.sleep(2)
            if getattr(bot, 'no_dm', False):
                startup.info("Startup DM skipped")
            elif getattr(bot, 'startup_dm_sent', False):
                startup.info("Startup DM sent to Global Admin")

            startup.ready()
        except Exception as e:
            logging.getLogger('bot').error(f"Error syncing commands: {e}")
            print(f"Error syncing commands: {e}")

    async def main():
        await load_cogs()

        startup.phase_start("Connecting to Discord")
        attempt = 0
        while True:
            attempt += 1
            try:
                await bot.start(bot_token)
                break  # Clean exit if bot.start() returns normally

            except discord.LoginFailure:
                startup.error_box("Login Failed", "Invalid bot token.", "Check your bot_token.txt file.\nCreate a bot application and token at: https://discord.com/developers/applications")
                break

            except discord.PrivilegedIntentsRequired:
                startup.error_box("Login Failed", "Privileged intents not enabled.", "Enable the required intents (Server Members, Message Content, Presence) for your bot at:\nhttps://discord.com/developers/applications -> your application -> Bot -> Privileged Gateway Intents")
                break

            except discord.HTTPException as e:
                if e.status == 429:
                    startup.connection_retry(attempt, "rate limited", 60)
                    await asyncio.sleep(60)
                elif e.status >= 500:
                    startup.connection_retry(attempt, f"server error (HTTP {e.status})", 30)
                    await asyncio.sleep(30)
                else:
                    startup.connection_retry(attempt, f"HTTP {e.status}", 30)
                    await asyncio.sleep(30)

            except discord.GatewayNotFound:
                startup.connection_retry(attempt, "gateway unavailable", 30)
                await asyncio.sleep(30)

            except (aiohttp.ClientConnectorDNSError, aiohttp.ClientConnectorError):
                startup.connection_retry(attempt, "connection failed", 30)
                await asyncio.sleep(30)

            except OSError as e:
                if e.errno in (-3, 11001):  # DNS errors (Linux/Windows)
                    startup.connection_retry(attempt, "DNS failed", 30)
                    await asyncio.sleep(30)
                else:
                    raise

    def run_bot():
        import signal

        async def start_bot():
            """Start the bot with proper shutdown handling."""
            stop_event = asyncio.Event()

            def signal_handler():
                if is_container():
                    print(f"\n  Received shutdown signal. Shutting down gracefully...")
                else:
                    print(f"\n  {startup.shutdown()}")
                stop_event.set()

            loop = asyncio.get_running_loop()

            # Register signal handlers
            if sys.platform != "win32":
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.add_signal_handler(sig, signal_handler)
            else:
                # Windows doesn't support add_signal_handler, use traditional signal
                def win_handler(signum, frame):
                    signal_handler()
                signal.signal(signal.SIGINT, win_handler)

            # Start bot in background task
            bot_task = asyncio.create_task(main())

            # Wait for either bot to finish or shutdown signal
            shutdown_task = asyncio.create_task(stop_event.wait())
            done, pending = await asyncio.wait(
                [bot_task, shutdown_task],
                return_when=asyncio.FIRST_COMPLETED
            )

            # Cancel pending tasks
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            # Cancel background loops + the queue worker up front so shutdown
            # doesn't wait on idle ticks. Bypasses ProcessQueue's 30s reload-drain.
            try:
                from discord.ext import tasks as _tasks_mod
                loop_tasks = []
                for cog in list(bot.cogs.values()):
                    for attr in dir(cog):
                        try:
                            obj = getattr(cog, attr)
                        except Exception:
                            continue
                        if isinstance(obj, _tasks_mod.Loop):
                            obj.cancel()
                            t = obj.get_task()
                            if t is not None:
                                loop_tasks.append(t)
                pq = bot.get_cog("ProcessQueue")
                if pq is not None:
                    pq._shutting_down = True
                    pq._wake_event.set()
                    pqt = getattr(pq, "_processor_task", None)
                    if pqt is not None and not pqt.done():
                        pqt.cancel()
                        loop_tasks.append(pqt)
                if loop_tasks:
                    await asyncio.wait(loop_tasks, timeout=3.0)
            except Exception as e:
                print(f"  Background-task shutdown hiccup: {e}")

            # Properly close the bot and await completion
            if not bot.is_closed():
                await bot.close()

        try:
            asyncio.run(start_bot())
        except KeyboardInterrupt:
            pass  # Already handled by signal handler

    run_bot()