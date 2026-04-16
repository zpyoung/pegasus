#!/bin/sh
# Mock claude CLI that emulates `claude -p --output-format stream-json`.
# Emits canned JSONL events to stdout for integration testing.
#
# Modes (MOCK_CLAUDE_MODE env var):
#   happy (default) - init + assistant + result:success then exit 0
#   slow            - init, then sleep, then assistant + result (for abort tests)
#   utf8            - init + assistant with multi-byte chars + result
#   error           - init + result:error_during_execution, exit 0

# Read (and discard) stdin if '-' flag was passed — provider sends the prompt there.
# Don't block if stdin is not a pipe.
if [ ! -t 0 ]; then
    cat >/dev/null 2>&1 || true
fi

MODE="${MOCK_CLAUDE_MODE:-happy}"
SESSION_ID="test-session-123"

emit_init() {
    printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$SESSION_ID"
}

emit_assistant() {
    text="$1"
    printf '{"type":"assistant","session_id":"%s","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$SESSION_ID" "$text"
}

emit_result_success() {
    text="$1"
    printf '{"type":"result","subtype":"success","session_id":"%s","result":"%s","total_cost_usd":0.001,"num_turns":1}\n' "$SESSION_ID" "$text"
}

emit_result_error() {
    printf '{"type":"result","subtype":"error_during_execution","session_id":"%s","error":"Test error"}\n' "$SESSION_ID"
}

case "$MODE" in
    slow)
        emit_init
        # Keep process alive long enough for abort test to fire
        sleep 10
        emit_assistant "Hello from mock Claude"
        emit_result_success "Hello from mock Claude"
        ;;
    utf8)
        emit_init
        # Multi-byte text: Japanese chars + rocket emoji (4-byte UTF-8)
        emit_assistant "こんにちは 🚀"
        emit_result_success "こんにちは 🚀"
        ;;
    error)
        emit_init
        emit_result_error
        ;;
    happy|*)
        emit_init
        emit_assistant "Hello from mock Claude"
        emit_result_success "Hello from mock Claude"
        ;;
esac

exit 0
