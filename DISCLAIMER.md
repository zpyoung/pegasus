# Security Disclaimer

## Important Warning

**Pegasus uses AI-powered tooling that has access to your operating system and can read, modify, and delete files. Use at your own risk.**

## Risk Assessment

This software utilizes AI agents (such as Claude) that can:

- **Read files** from your file system
- **Write and modify files** in your projects
- **Delete files** when instructed
- **Execute commands** on your operating system
- **Access environment variables** and configuration files

While we have made efforts to review this codebase for security vulnerabilities and implement safeguards, **you assume all risk** when running this software.

## Recommendations

### 1. Review the Code First

Before running Pegasus, we strongly recommend reviewing the source code yourself to understand what operations it performs and ensure you are comfortable with its behavior.

### 2. Use Sandboxing (Highly Recommended)

**We do not recommend running Pegasus directly on your local computer** due to the risk of AI agents having access to your entire file system. Instead, consider:

- **Docker**: Run Pegasus in a Docker container to isolate it from your host system
- **Virtual Machine**: Use a VM (such as VirtualBox, VMware, or Parallels) to create an isolated environment
- **Cloud Development Environment**: Use a cloud-based development environment that provides isolation

#### Running in Isolated Docker Container

For maximum security, run Pegasus in an isolated Docker container that **cannot access your laptop's files**:

```bash
# 1. Set your API key (bash/Linux/Mac - creates UTF-8 file)
echo "ANTHROPIC_API_KEY=your-api-key-here" > .env

# On Windows PowerShell, use instead:
Set-Content -Path .env -Value "ANTHROPIC_API_KEY=your-api-key-here" -Encoding UTF8

# 2. Build and run isolated container
docker-compose up -d

# 3. Access the UI at http://localhost:3007
#    API at http://localhost:3008/api/health
```

The container uses only Docker-managed volumes and has no access to your host filesystem. See [docker-isolation.md](docs/docker-isolation.md) for full documentation.

### 3. Limit Access

If you must run locally:

- Create a dedicated user account with limited permissions
- Only grant access to specific project directories
- Avoid running with administrator/root privileges
- Keep sensitive files and credentials outside of project directories

### 4. Monitor Activity

- Review the agent's actions in the output logs
- Pay attention to file modifications and command executions
- Stop the agent immediately if you notice unexpected behavior

## No Warranty & Limitation of Liability

THE SOFTWARE UTILIZES ARTIFICIAL INTELLIGENCE TO GENERATE CODE, EXECUTE COMMANDS, AND INTERACT WITH YOUR FILE SYSTEM. YOU ACKNOWLEDGE THAT AI SYSTEMS CAN BE UNPREDICTABLE, MAY GENERATE INCORRECT, INSECURE, OR DESTRUCTIVE CODE, AND MAY TAKE ACTIONS THAT COULD DAMAGE YOUR SYSTEM, FILES, OR HARDWARE.

This software is provided "as is", without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, including but not limited to hardware damage, data loss, financial loss, or business interruption, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

## Acknowledgment

By using Pegasus, you acknowledge that:

1. You have read and understood this disclaimer
2. You accept full responsibility for any consequences of using this software
3. You understand the risks of AI agents having access to your operating system
4. You agree to take appropriate precautions as outlined above

---

**If you are not comfortable with these risks, do not use this software.**
