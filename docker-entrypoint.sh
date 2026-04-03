#!/bin/sh
set -e

# Ensure Claude CLI config directory exists with correct permissions
if [ ! -d "/home/pegasus/.claude" ]; then
    mkdir -p /home/pegasus/.claude
fi

# If CLAUDE_OAUTH_CREDENTIALS is set, write it to the credentials file
# This allows passing OAuth tokens from host (especially macOS where they're in Keychain)
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
    echo "$CLAUDE_OAUTH_CREDENTIALS" > /home/pegasus/.claude/.credentials.json
    chmod 600 /home/pegasus/.claude/.credentials.json
fi

# Fix permissions on Claude CLI config directory
chown -R pegasus:pegasus /home/pegasus/.claude
chmod 700 /home/pegasus/.claude

# Ensure Cursor CLI config directory exists with correct permissions
# This handles both: mounted volumes (owned by root) and empty directories
if [ ! -d "/home/pegasus/.cursor" ]; then
    mkdir -p /home/pegasus/.cursor
fi
chown -R pegasus:pegasus /home/pegasus/.cursor
chmod -R 700 /home/pegasus/.cursor

# Ensure OpenCode CLI config directory exists with correct permissions
# OpenCode stores config and auth in ~/.local/share/opencode/
if [ ! -d "/home/pegasus/.local/share/opencode" ]; then
    mkdir -p /home/pegasus/.local/share/opencode
fi
chown -R pegasus:pegasus /home/pegasus/.local/share/opencode
chmod -R 700 /home/pegasus/.local/share/opencode

# OpenCode also uses ~/.config/opencode for configuration
if [ ! -d "/home/pegasus/.config/opencode" ]; then
    mkdir -p /home/pegasus/.config/opencode
fi
chown -R pegasus:pegasus /home/pegasus/.config/opencode
chmod -R 700 /home/pegasus/.config/opencode

# OpenCode also uses ~/.cache/opencode for cache data (version file, etc.)
if [ ! -d "/home/pegasus/.cache/opencode" ]; then
    mkdir -p /home/pegasus/.cache/opencode
fi
chown -R pegasus:pegasus /home/pegasus/.cache/opencode
chmod -R 700 /home/pegasus/.cache/opencode

# Ensure npm cache directory exists with correct permissions
# This is needed for using npx to run MCP servers
if [ ! -d "/home/pegasus/.npm" ]; then
    mkdir -p /home/pegasus/.npm
fi
chown -R pegasus:pegasus /home/pegasus/.npm

# If CURSOR_AUTH_TOKEN is set, write it to the cursor auth file
# On Linux, cursor-agent uses ~/.config/cursor/auth.json for file-based credential storage
# The env var CURSOR_AUTH_TOKEN is also checked directly by cursor-agent
if [ -n "$CURSOR_AUTH_TOKEN" ]; then
    CURSOR_CONFIG_DIR="/home/pegasus/.config/cursor"
    mkdir -p "$CURSOR_CONFIG_DIR"
    # Write auth.json with the access token
    cat > "$CURSOR_CONFIG_DIR/auth.json" << EOF
{
  "accessToken": "$CURSOR_AUTH_TOKEN"
}
EOF
    chmod 600 "$CURSOR_CONFIG_DIR/auth.json"
    chown -R pegasus:pegasus /home/pegasus/.config
fi

# Switch to pegasus user and execute the command
exec gosu pegasus "$@"
