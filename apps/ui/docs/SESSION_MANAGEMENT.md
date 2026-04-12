# Session Management Guide

## Overview

The Pegasus Agent Chat now supports multiple concurrent sessions, allowing you to organize different conversations by topic, feature, or task. Each session is independently managed and persisted.

## Features

### ✨ Multiple Sessions

- Create unlimited agent sessions per project
- Each session has its own conversation history
- Switch between sessions instantly
- Sessions persist across app restarts

### 📋 Session Organization

- Custom names for easy identification
- Last message preview
- Message count tracking
- Sort by most recently updated

### 🗄️ Archive & Delete

- Archive old sessions to declutter
- Unarchive when needed
- Permanently delete sessions
- Confirm before destructive actions

### 💾 Automatic Persistence

- All sessions auto-save to disk
- Survive Next.js restarts
- Survive Electron app restarts
- Never lose your conversations

## User Interface

### Session Manager Sidebar

Located on the left side of the Agent Chat view:

```
┌──────────────────────────┬────────────────────────┐
│  Session Manager         │  Chat Messages         │
│                          │                        │
│  [+ New]  [Archive]      │  User: Hello           │
│                          │  Agent: Hi there!      │
│  📝 Feature: Auth        │                        │
│     "Add OAuth login..." │  [Input field]         │
│     42 messages          │                        │
│                          │                        │
│  📝 Bug: Payment         │                        │
│     "Fix stripe inte..." │                        │
│     15 messages          │                        │
│                          │                        │
└──────────────────────────┴────────────────────────┘
```

### Toggle Sidebar

Click the panel icon in the header to show/hide the session manager.

## How to Use

### Creating a Session

1. Click the **"+ New"** button
2. Enter a descriptive name
3. Press Enter or click ✓
4. The new session is immediately active

**Example session names:**

- "Feature: Dark Mode"
- "Bug: Login redirect"
- "Refactor: API layer"
- "Docs: Getting started"

### Switching Sessions

Simply click on any session in the list to switch to it. The conversation history loads instantly.

### Renaming a Session

1. Click the edit icon (✏️) next to the session name
2. Type the new name
3. Press Enter or click ✓

### Clearing a Session

Click the **"Clear"** button in the chat header to delete all messages from the current session while keeping the session itself.

### Archiving a Session

1. Click the archive icon (📦) next to the session
2. The session moves to the archived list
3. Toggle **"Show Archived"** to view archived sessions

**When to archive:**

- Completed features
- Resolved bugs
- Old experiments
- Historical reference

### Unarchiving a Session

1. Toggle **"Show Archived"** to see archived sessions
2. Click the unarchive icon (📤)
3. The session returns to the active list

### Deleting a Session

1. Archive the session first
2. View archived sessions
3. Click the delete icon (🗑️)
4. Confirm the deletion
5. **This is permanent!**

## Storage Location

Sessions are stored in your user data directory:

**macOS:**

```
~/Library/Application Support/pegasus/agent-sessions/
```

**Windows:**

```
%APPDATA%/pegasus/agent-sessions/
```

**Linux:**

```
~/.config/pegasus/agent-sessions/
```

### File Structure

```
agent-sessions/
├── session_1234567890_abc.json       # Session conversation
├── session_1234567891_def.json       # Another session
└── sessions-metadata.json            # Session metadata
```

### Session File Format

Each session file contains an array of messages:

```json
[
  {
    "id": "msg_1234567890_xyz",
    "role": "user",
    "content": "Add authentication to the app",
    "timestamp": "2024-12-07T12:00:00.000Z"
  },
  {
    "id": "msg_1234567891_abc",
    "role": "assistant",
    "content": "I'll help you add authentication...",
    "timestamp": "2024-12-07T12:00:05.000Z"
  }
]
```

### Metadata File Format

The metadata file tracks all sessions:

```json
{
  "session_1234567890_abc": {
    "name": "Feature: Authentication",
    "projectPath": "/path/to/project",
    "createdAt": "2024-12-07T12:00:00.000Z",
    "updatedAt": "2024-12-07T12:30:00.000Z",
    "isArchived": false,
    "tags": []
  }
}
```

## Best Practices

### Naming Conventions

Use prefixes to organize sessions by type:

- **Feature:** New functionality
  - "Feature: Dark mode toggle"
  - "Feature: User profiles"

- **Bug:** Issue resolution
  - "Bug: Memory leak in dashboard"
  - "Bug: Form validation errors"

- **Refactor:** Code improvements
  - "Refactor: Database layer"
  - "Refactor: Component structure"

- **Docs:** Documentation work
  - "Docs: API documentation"
  - "Docs: README updates"

- **Experiment:** Try new ideas
  - "Experiment: WebGL renderer"
  - "Experiment: New state management"

### Session Lifecycle

1. **Create** → Start a new feature or task
2. **Work** → Have conversation, iterate on code
3. **Complete** → Finish the task
4. **Archive** → Keep for reference
5. **Delete** → Remove when no longer needed

### When to Create Multiple Sessions

**Do create separate sessions for:**

- ✅ Different features
- ✅ Unrelated bugs
- ✅ Experimental work
- ✅ Different contexts or approaches

**Don't create separate sessions for:**

- ❌ Same feature, different iterations
- ❌ Related bug fixes
- ❌ Continuation of previous work

### Managing Session Clutter

- Archive completed work weekly
- Delete archived sessions after 30 days
- Use clear naming conventions
- Consolidate related sessions

## Integration with Project Workflow

### Feature Development

```
1. Create: "Feature: User notifications"
2. Agent: Design the notification system
3. Agent: Implement backend
4. Next.js restarts (agent continues)
5. Agent: Implement frontend
6. Agent: Add tests
7. Complete & Archive
```

### Bug Fixing

```
1. Create: "Bug: Payment processing timeout"
2. Agent: Investigate the issue
3. Agent: Identify root cause
4. Agent: Implement fix
5. Agent: Add regression test
6. Complete & Archive
```

### Refactoring

```
1. Create: "Refactor: API error handling"
2. Agent: Analyze current implementation
3. Agent: Design new approach
4. Agent: Refactor service layer
5. Next.js restarts (agent continues)
6. Agent: Refactor controller layer
7. Agent: Update tests
8. Complete & Archive
```

## Keyboard Shortcuts

_(Coming soon)_

- `Cmd/Ctrl + K` - Create new session
- `Cmd/Ctrl + [` - Previous session
- `Cmd/Ctrl + ]` - Next session
- `Cmd/Ctrl + Shift + A` - Toggle archive view

## Troubleshooting

### Session Not Saving

**Check:**

- Electron has write permissions
- Disk space available
- Check Electron console for errors

**Solution:**

```bash
# macOS - Check permissions
ls -la ~/Library/Application\ Support/pegasus/

# Fix permissions if needed
chmod -R u+w ~/Library/Application\ Support/pegasus/
```

### Can't Switch Sessions

**Check:**

- Session is not archived
- No errors in console
- Agent is not currently processing

**Solution:**

- Wait for current message to complete
- Check for error messages
- Try clearing and reloading

### Session Disappeared

**Check:**

- Not filtered by archive status
- Not accidentally deleted
- Check backup files

**Recovery:**

- Toggle "Show Archived"
- Check filesystem for `.json` files
- Restore from backup if available

## API Reference

For developers integrating session management:

### Create Session

```typescript
const result = await window.electronAPI.sessions.create(
  "Session Name",
  "/project/path",
  "/working/directory",
);
```

### List Sessions

```typescript
const { sessions } = await window.electronAPI.sessions.list(
  false, // includeArchived
);
```

### Update Session

```typescript
await window.electronAPI.sessions.update(sessionId, "New Name", [
  "tag1",
  "tag2",
]);
```

### Archive/Unarchive

```typescript
await window.electronAPI.sessions.archive(sessionId);
await window.electronAPI.sessions.unarchive(sessionId);
```

### Delete Session

```typescript
await window.electronAPI.sessions.delete(sessionId);
```

## Future Enhancements

- [ ] Tag system for categorization
- [ ] Search sessions by content
- [ ] Export session to markdown
- [ ] Share sessions with team
- [ ] Session templates
- [ ] Keyboard shortcuts
- [ ] Drag & drop to reorder
- [ ] Favorite/pin sessions
- [ ] Session statistics
- [ ] Automatic archiving rules
