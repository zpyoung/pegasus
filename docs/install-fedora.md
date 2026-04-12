# Installing Pegasus on Fedora/RHEL

This guide covers installation of Pegasus on Fedora, RHEL, Rocky Linux, AlmaLinux, and other RPM-based distributions.

## Prerequisites

Pegasus requires:

- **64-bit x86_64 architecture**
- **Fedora 39+** or **RHEL 9+** (earlier versions may work but not officially supported)
- **4GB RAM minimum**, 8GB recommended
- **~300MB disk space** for installation
- **Internet connection** for installation and Claude API access

### Authentication

You'll need one of the following:

- **Claude CLI** (recommended) - `claude login`
- **API key** - Set `ANTHROPIC_API_KEY` environment variable

See main [README.md authentication section](../README.md#authentication) for details.

## Installation

### Option 1: Download and Install from GitHub

1. Visit [GitHub Releases](https://github.com/zpyoung/pegasus/releases)
2. Find the latest release and download the `.rpm` file:
   - Download: `Pegasus-<version>-x86_64.rpm`

3. Install using dnf (Fedora):

   ```bash
   sudo dnf install ./Pegasus-<version>-x86_64.rpm
   ```

   Or using yum (RHEL/CentOS):

   ```bash
   sudo yum localinstall ./Pegasus-<version>-x86_64.rpm
   ```

### Option 2: Install Directly from URL

Install from GitHub releases URL without downloading first. Visit [releases page](https://github.com/zpyoung/pegasus/releases) to find the latest version.

**Fedora:**

```bash
# Replace v0.11.0 with the actual latest version
sudo dnf install https://github.com/zpyoung/pegasus/releases/download/v0.11.0/Pegasus-0.11.0-x86_64.rpm
```

**RHEL/CentOS:**

```bash
# Replace v0.11.0 with the actual latest version
sudo yum install https://github.com/zpyoung/pegasus/releases/download/v0.11.0/Pegasus-0.11.0-x86_64.rpm
```

## Running Pegasus

After successful installation, launch Pegasus:

### From Application Menu

- Open Activities/Applications
- Search for "Pegasus"
- Click to launch

### From Terminal

```bash
pegasus
```

## System Requirements & Capabilities

### Hardware Requirements

| Component    | Minimum           | Recommended |
| ------------ | ----------------- | ----------- |
| CPU          | Modern multi-core | 4+ cores    |
| RAM          | 4GB               | 8GB+        |
| Disk         | 300MB             | 1GB+        |
| Architecture | x86_64            | x86_64      |

### Required Dependencies

The RPM package automatically installs these dependencies:

```
gtk3              - GTK+ GUI library
libnotify         - Desktop notification library
nss               - Network Security Services
libXScrnSaver     - X11 screensaver library
libXtst           - X11 testing library
xdg-utils         - XDG standards utilities
at-spi2-core      - Accessibility library
libuuid           - UUID library
```

Most of these are pre-installed on typical Fedora/RHEL systems.

### Optional Dependencies

For development (source builds only):

- Node.js 22.x (exactly; `>=22.0.0 <23.0.0` is required)
- pnpm 9+

The packaged application includes its own Electron runtime and does not require system Node.js.

## Supported Distributions

**Officially Tested:**

- Fedora 39, 40 (latest)
- Rocky Linux 9
- AlmaLinux 9

**Should Work:**

- CentOS Stream 9+
- openSUSE Leap/Tumbleweed (with compatibility layer)
- RHEL 9+

**Not Supported:**

- RHEL 8 (glibc 2.28 too old, requires Node.js 22)
- CentOS 7 and earlier
- Fedora versions older than 39

## Configuration

### Environment Variables

Set authentication via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pegasus
```

Or create a `.env` file in the directory where you launch Pegasus:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### Configuration Directory

Pegasus stores data relative to the process working directory by default:

```
./data/                    # Global settings, credentials, agent sessions
                           # (override with DATA_DIR environment variable)
.pegasus/                  # Per-project data written inside each project repo
                           # (features, context files, spec, analysis)
```

The `DATA_DIR` defaults to `./data` (relative to where Pegasus is launched). To use a fixed location, set the environment variable before starting Pegasus:

```bash
export DATA_DIR=/var/lib/pegasus
pegasus
```

## Troubleshooting

### Application Won't Start

**Check installation:**

```bash
rpm -qi pegasus
rpm -V pegasus
```

**Verify desktop file:**

```bash
cat /usr/share/applications/pegasus.desktop
```

**Run from terminal for error output:**

```bash
pegasus
```

### Missing Dependencies

If dependencies fail to install automatically:

**Fedora:**

```bash
sudo dnf install gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid
```

**RHEL/CentOS (enable EPEL first if needed):**

```bash
sudo dnf install epel-release
sudo dnf install gtk3 libnotify nss libXScrnSaver libXtst xdg-utils at-spi2-core libuuid
```

### SELinux Denials

If Pegasus fails on SELinux-enforced systems:

**Temporary workaround (testing):**

```bash
# Set SELinux to permissive mode
sudo setenforce 0

# Run Pegasus
pegasus

# Check for denials
sudo ausearch -m avc -ts recent | grep pegasus

# Re-enable SELinux
sudo setenforce 1
```

**Permanent fix (not recommended for production):**
Create custom SELinux policy based on ausearch output. For support, see [GitHub Issues](https://github.com/zpyoung/pegasus/issues).

### Port Conflicts

Pegasus uses port 3008 for the internal server. If port is already in use:

**Find process using port 3008:**

```bash
sudo ss -tlnp | grep 3008
# or
lsof -i :3008
```

**Kill conflicting process (if safe):**

```bash
sudo kill -9 <PID>
```

Or configure Pegasus to use different port (see Configuration section).

### Firewall Issues

On Fedora with firewalld enabled:

```bash
# Allow internal traffic (local development only)
sudo firewall-cmd --add-port=3008/tcp
sudo firewall-cmd --permanent --add-port=3008/tcp
```

### GPU/Acceleration

Pegasus uses Chromium for rendering. GPU acceleration should work automatically on supported systems.

**Check acceleration:**

- Look for "GPU acceleration" status in application settings
- Verify drivers: `lspci | grep VGA`

**Disable acceleration if issues occur:**

Pass Electron's built-in flag directly:

```bash
pegasus --disable-gpu
```

### Terminal/Worktree Issues

If terminal emulator fails or git worktree operations hang:

1. Check disk space: `df -h`
2. Verify git installation: `git --version`
3. Check /tmp permissions: `ls -la /tmp`
4. File a GitHub issue with error output

### Unresponsive GUI

If the application freezes:

1. Wait 30 seconds (AI operations may be processing)
2. Check process: `ps aux | grep pegasus`
3. Force quit if necessary: `killall pegasus`
4. Check system resources: `free -h`, `top`

### Network Issues

If Claude API calls fail:

```bash
# Test internet connectivity
ping -c 3 api.anthropic.com

# Test API access
curl -I https://api.anthropic.com

# Verify API key is set (without exposing the value)
[ -n "$ANTHROPIC_API_KEY" ] && echo "API key is set" || echo "API key is NOT set"
```

## Uninstallation

### Remove Application

**Fedora:**

```bash
sudo dnf remove pegasus
```

**RHEL/CentOS:**

```bash
sudo yum remove pegasus
```

### Clean Configuration (Optional)

Remove all user data and configuration:

```bash
# Remove global Pegasus data (default location, adjust if you set DATA_DIR)
rm -rf ./data

# Remove per-project data (run inside each project repo)
rm -rf .pegasus
```

**Warning:** This removes all saved projects and settings. Ensure you have backups if needed.

## Building from Source

To build Pegasus from source on Fedora/RHEL:

**Prerequisites:**

Node.js 22.x is required (exactly; the project enforces `>=22.0.0 <23.0.0`). Install pnpm after Node.js:

```bash
# Fedora
sudo dnf install nodejs git
npm install -g pnpm

# RHEL (enable EPEL first)
sudo dnf install epel-release
sudo dnf install nodejs git
npm install -g pnpm
```

**Build steps:**

```bash
# Clone repository
git clone https://github.com/zpyoung/pegasus.git
cd pegasus

# Install dependencies
pnpm install

# Build Linux packages (build:packages is included automatically)
pnpm build:electron:linux

# Packages in: apps/ui/release/
# Linux produces three formats: AppImage, .deb, and .rpm
ls apps/ui/release/
```

See main [README.md](../README.md) for detailed build instructions.

## Updating Pegasus

**Automatic Updates:**
Pegasus checks for updates on startup. Install available updates through notifications.

**Manual Update:**

```bash
# Fedora
sudo dnf update pegasus

# RHEL/CentOS
sudo yum update pegasus

# Or reinstall latest release
sudo dnf remove pegasus

# Download the latest .rpm from releases page
# https://github.com/zpyoung/pegasus/releases
# Then reinstall with:
# sudo dnf install ./Pegasus-<VERSION>-x86_64.rpm
```

## Getting Help

### Resources

- [Main README](../README.md) - Project overview
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Contributing guide
- [GitHub Issues](https://github.com/zpyoung/pegasus/issues) - Bug reports & feature requests
- [Discussions](https://github.com/zpyoung/pegasus/discussions) - Questions & community

### Reporting Issues

When reporting Fedora/RHEL issues, include:

```bash
# System information
lsb_release -a
uname -m

# Pegasus version
rpm -qi pegasus

# Error output (run from terminal)
pegasus 2>&1 | tee pegasus.log

# SELinux status
getenforce

# Relevant system logs
sudo journalctl -xeu pegasus.service (if systemd service exists)
```

## Performance Tips

1. **Use SSD**: Faster than spinning disk, significantly improves performance
2. **Close unnecessary applications**: Free up RAM for AI agent processing
3. **Disable GPU acceleration if glitchy**: Run `pegasus --disable-gpu`
4. **Keep system updated**: `sudo dnf update`
5. **Use latest Fedora/RHEL**: Newer versions have better Electron support

## Security Considerations

### API Key Security

Never commit API keys to version control:

```bash
# Good: Use environment variable
export ANTHROPIC_API_KEY=sk-ant-...

# Good: Use .env file in the repo root (not committed to git)
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# Bad: Hardcoded in files
ANTHROPIC_API_KEY="sk-ant-..." (in any tracked file)
```

### SELinux Security

Running with SELinux disabled (`setenforce 0`) reduces security. Create custom policy:

1. Generate policy from audit logs: `ausearch -m avc -ts recent | grep pegasus`
2. Use selinux-policy tools to create module
3. Install and test module
4. Keep SELinux enforcing

### File Permissions

Ensure configuration files are readable by user only:

```bash
# Protect the .env file in your project root
chmod 600 .env

# Protect the per-project data directory
chmod 700 .pegasus/

# Protect the global data directory (adjust path if DATA_DIR is set)
chmod 700 ./data/
```

## Known Limitations

1. **Single display support**: Multi-monitor setups may have cursor synchronization issues
2. **X11 only**: Wayland support limited (runs under XWayland)
3. **No native systemd service**: Manual launcher or desktop file shortcut
4. **ARM/ARM64**: Not supported, x86_64 only

## Contributing

Found an issue or want to improve Fedora support? See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

**Last Updated**: 2026-01-16
**Tested On**: Fedora 40, Rocky Linux 9, AlmaLinux 9
