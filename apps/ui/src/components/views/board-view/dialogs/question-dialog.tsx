'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Feature } from '@/store/app-store';
import type { AgentQuestion } from '@pegasus/types';
import { MessageSquare, Bot } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { QuestionHelperPanel } from './question-helper-panel';
import { getHttpApiClient } from '@/lib/http-api-client';

/**
 * Sentinel value used internally to track that the user picked the synthetic
 * "Other" option from a single-select or multi-select question.
 *
 * The sentinel never reaches the server: at submit time it is replaced with
 * the user's typed custom text. Splitting by comma is safe because option
 * labels coming from the SDK are short ("1-5 words", per AskUserQuestionInput
 * docs) and a sentinel that contains a comma would defeat the purpose.
 */
export const OTHER_OPTION_SENTINEL = '__OTHER__';

/** Display label for the synthetic "Other" option. */
const OTHER_OPTION_LABEL = 'Other';

/**
 * Split a multi-select answer string into the array of selected option labels.
 * Inverse of `joinMultiSelectAnswer`.
 */
function splitMultiSelectAnswer(answer: string): string[] {
  return answer ? answer.split(', ').filter(Boolean) : [];
}

/** Join an array of selected option labels back into the canonical answer string. */
function joinMultiSelectAnswer(labels: string[]): string {
  return labels.join(', ');
}

/**
 * Renders a per-question answer input matching the question type.
 * Used internally by QuestionDialog.
 *
 * For select-type questions (single-select / multi-select), a synthetic
 * "Other" option is appended after the agent-supplied options. When picked,
 * a textarea is revealed and its contents are reported via `onOtherTextChange`.
 */
function QuestionItem({
  question,
  answer,
  onChange,
  otherText,
  onOtherTextChange,
  disabled,
  autoFocus,
}: {
  question: AgentQuestion;
  answer: string;
  onChange: (value: string) => void;
  otherText: string;
  onOtherTextChange: (value: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  const multiSelectSelected = splitMultiSelectAnswer(answer);
  const isSingleSelectOther = question.type === 'single-select' && answer === OTHER_OPTION_SENTINEL;
  const isMultiSelectOther =
    question.type === 'multi-select' && multiSelectSelected.includes(OTHER_OPTION_SENTINEL);

  const handleMultiSelectChange = (optionValue: string, checked: boolean) => {
    const updated = checked
      ? [...multiSelectSelected, optionValue]
      : multiSelectSelected.filter((s) => s !== optionValue);
    onChange(joinMultiSelectAnswer(updated));
  };

  /**
   * Render the synthetic "Other" textarea below the option list. Shared between
   * single-select and multi-select since the only difference is the trigger.
   */
  const renderOtherTextInput = () => (
    <div className="pl-7 pt-2">
      <Textarea
        value={otherText}
        onChange={(e) => onOtherTextChange(e.target.value)}
        placeholder="Type your answer..."
        className="min-h-[60px]"
        disabled={disabled}
        autoFocus
        data-testid={`other-text-${question.id}`}
      />
    </div>
  );

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium leading-relaxed">{question.question}</Label>

      {question.type === 'free-text' && (
        <Textarea
          value={answer}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type your answer..."
          className="min-h-[80px]"
          disabled={disabled}
          autoFocus={autoFocus}
        />
      )}

      {question.type === 'single-select' && question.options && (
        <RadioGroup value={answer} onValueChange={onChange} className="space-y-1">
          {question.options.map((option) => (
            <div key={option.label} className="flex items-start space-x-3">
              <RadioGroupItem
                value={option.label}
                id={`option-${question.id}-${option.label}`}
                disabled={disabled}
              />
              <Label
                htmlFor={`option-${question.id}-${option.label}`}
                className="cursor-pointer leading-relaxed"
              >
                <span className="font-medium">{option.label}</span>
                {option.description && (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                )}
              </Label>
            </div>
          ))}
          {/* Synthetic "Other" radio — always rendered last for select questions */}
          <div className="flex items-start space-x-3">
            <RadioGroupItem
              value={OTHER_OPTION_SENTINEL}
              id={`option-${question.id}-other`}
              disabled={disabled}
              data-testid={`option-${question.id}-other`}
            />
            <Label
              htmlFor={`option-${question.id}-other`}
              className="cursor-pointer leading-relaxed"
            >
              <span className="font-medium">{OTHER_OPTION_LABEL}</span>
              <span className="block text-xs text-muted-foreground">
                Provide a custom answer
              </span>
            </Label>
          </div>
          {isSingleSelectOther && renderOtherTextInput()}
        </RadioGroup>
      )}

      {question.type === 'multi-select' && question.options && (
        <div className="space-y-1">
          {question.options.map((option) => (
            <div key={option.label} className="flex items-start space-x-3">
              <Checkbox
                id={`option-${question.id}-${option.label}`}
                checked={multiSelectSelected.includes(option.label)}
                onCheckedChange={(checked) => handleMultiSelectChange(option.label, !!checked)}
                disabled={disabled}
              />
              <Label
                htmlFor={`option-${question.id}-${option.label}`}
                className="cursor-pointer leading-relaxed"
              >
                <span className="font-medium">{option.label}</span>
                {option.description && (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                )}
              </Label>
            </div>
          ))}
          {/* Synthetic "Other" checkbox — always rendered last for select questions */}
          <div className="flex items-start space-x-3">
            <Checkbox
              id={`option-${question.id}-other`}
              checked={isMultiSelectOther}
              onCheckedChange={(checked) =>
                handleMultiSelectChange(OTHER_OPTION_SENTINEL, !!checked)
              }
              disabled={disabled}
              data-testid={`option-${question.id}-other`}
            />
            <Label
              htmlFor={`option-${question.id}-other`}
              className="cursor-pointer leading-relaxed"
            >
              <span className="font-medium">{OTHER_OPTION_LABEL}</span>
              <span className="block text-xs text-muted-foreground">
                Provide a custom answer
              </span>
            </Label>
          </div>
          {isMultiSelectOther && renderOtherTextInput()}
        </div>
      )}
    </div>
  );
}

/**
 * Build the final answer string for a single question, substituting the
 * "Other" sentinel with the trimmed custom text. Exported for direct unit
 * testing of the substitution rules.
 */
export function buildFinalAnswer(
  question: AgentQuestion,
  rawAnswer: string,
  otherText: string
): string {
  const trimmedOther = otherText.trim();

  if (question.type === 'single-select') {
    if (rawAnswer === OTHER_OPTION_SENTINEL) {
      return trimmedOther;
    }
    return rawAnswer.trim();
  }

  if (question.type === 'multi-select') {
    const labels = splitMultiSelectAnswer(rawAnswer);
    const substituted = labels.map((label) =>
      label === OTHER_OPTION_SENTINEL ? trimmedOther : label
    );
    // Drop any empty entries (e.g. if Other was checked but no text was entered —
    // validation should prevent this from being submitted, but defend anyway)
    return substituted.filter((s) => s.length > 0).join(', ');
  }

  // free-text
  return rawAnswer.trim();
}

/**
 * Determine whether the user has provided enough input to submit a single
 * question. Used for the global submit-disabled check. Exported for testing.
 */
export function isQuestionAnswered(
  question: AgentQuestion,
  rawAnswer: string,
  otherText: string
): boolean {
  if (question.type === 'free-text') {
    return rawAnswer.trim().length > 0;
  }

  if (question.type === 'single-select') {
    if (!rawAnswer) return false;
    if (rawAnswer === OTHER_OPTION_SENTINEL) {
      return otherText.trim().length > 0;
    }
    return true;
  }

  if (question.type === 'multi-select') {
    const labels = splitMultiSelectAnswer(rawAnswer);
    if (labels.length === 0) return false;
    if (labels.includes(OTHER_OPTION_SENTINEL)) {
      return otherText.trim().length > 0;
    }
    return true;
  }

  return false;
}

interface QuestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  feature: Feature | null;
  questions: AgentQuestion[];
  /** Called with all answers at once when the user submits */
  onSubmitAllAnswers: (answers: Array<{ questionId: string; answer: string }>) => Promise<void>;
  isLoading?: boolean;
  /** Project path for the helper sub-agent (enables read-only codebase chat) */
  projectPath?: string;
}

export function QuestionDialog({
  open,
  onOpenChange,
  feature,
  questions,
  onSubmitAllAnswers,
  isLoading = false,
  projectPath,
}: QuestionDialogProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Per-question free-text used when the synthetic "Other" option is selected
  // for a single-select / multi-select question. Stored separately from
  // `answers` so deselecting "Other" doesn't lose the typed text in case the
  // user reselects it, AND so we can re-validate without coupling state shapes.
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // FR-007: visible by default on ≥1024px, hidden by default on narrower viewports.
  const [showHelper, setShowHelper] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 1024
  );

  const helperFeatureId = feature?.id ?? null;
  const helperAvailable = !!(projectPath && helperFeatureId);

  // Terminate helper session when dialog closes (FR-006).
  useEffect(() => {
    if (!open && helperAvailable && helperFeatureId) {
      getHttpApiClient()
        .questionHelper.endSession(helperFeatureId)
        .catch(() => {
          /* best-effort */
        });
    }
  }, [open, helperAvailable, helperFeatureId]);

  // Reset answers when dialog opens with new questions
  useEffect(() => {
    if (open) {
      setAnswers({});
      setOtherTexts({});
    }
  }, [open, questions]);

  const pendingQuestions = questions.filter((q) => q.status === 'pending');

  // All pending questions must have a non-empty answer to enable submit.
  // For select-type questions where "Other" is picked, the textarea must
  // also be non-empty (handled by `isQuestionAnswered`).
  const allAnswered =
    pendingQuestions.length > 0 &&
    pendingQuestions.every((q) =>
      isQuestionAnswered(q, answers[q.id] ?? '', otherTexts[q.id] ?? '')
    );

  const isSubmitDisabled = !allAnswered || submitting || isLoading;

  const handleChange = (questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  const handleOtherTextChange = (questionId: string, value: string) => {
    setOtherTexts((prev) => ({ ...prev, [questionId]: value }));
  };

  const handleSubmit = async () => {
    if (isSubmitDisabled) return;
    // Substitute the "Other" sentinel with the user's typed text. The server
    // never sees the sentinel — it gets the final answer string exactly as
    // before, so no API or storage changes are needed.
    const payload = pendingQuestions.map((q) => ({
      questionId: q.id,
      answer: buildFinalAnswer(q, answers[q.id] ?? '', otherTexts[q.id] ?? ''),
    }));
    setSubmitting(true);
    try {
      await onSubmitAllAnswers(payload);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = (open: boolean) => {
    if (!open && !submitting && !isLoading) {
      onOpenChange(false);
    }
  };

  if (pendingQuestions.length === 0) return null;

  const showHelperPanel = helperAvailable && showHelper;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={`w-full max-h-[85vh] flex flex-col ${showHelperPanel ? 'max-w-[min(95vw,1500px)]' : 'max-w-5xl'}`}
        data-testid="question-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-amber-500" />
            Agent Question{pendingQuestions.length > 1 ? 's' : ''}
            {feature?.title && (
              <span className="font-normal text-muted-foreground text-sm">
                — {feature.title}
              </span>
            )}
            {helperAvailable && (
              <Button
                variant="ghost"
                size="sm"
                // mr-8 leaves clearance for the Dialog's built-in close button
                // (positioned at right-4 top-4) so the two controls don't overlap.
                className="ml-auto mr-8 h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setShowHelper((v) => !v)}
                title={showHelper ? 'Hide code helper' : 'Show code helper'}
              >
                <Bot className="h-4 w-4 mr-1" />
                {showHelper ? 'Hide helper' : 'Ask about codebase'}
              </Button>
            )}
          </DialogTitle>
          <DialogDescription>
            {pendingQuestions.length > 1
              ? `The agent needs your input on ${pendingQuestions.length} questions before continuing.`
              : 'The agent needs your input before continuing. Answer the question below to resume execution.'}
          </DialogDescription>
        </DialogHeader>

        {/* Main body: questions on left, optional helper on right */}
        <div className="flex flex-1 gap-4 overflow-hidden min-h-0">
          {/* Questions column */}
          <div className="flex flex-col flex-1 overflow-hidden min-w-0">
            {/* Scrollable question area */}
            <div className="overflow-y-auto flex-1 space-y-6 py-2 pr-1">
              {pendingQuestions.map((question, index) => (
                <div key={question.id}>
                  {pendingQuestions.length > 1 && (
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                      Question {index + 1} of {pendingQuestions.length}
                    </p>
                  )}
                  <QuestionItem
                    question={question}
                    answer={answers[question.id] ?? ''}
                    onChange={(value) => handleChange(question.id, value)}
                    otherText={otherTexts[question.id] ?? ''}
                    onOtherTextChange={(value) => handleOtherTextChange(question.id, value)}
                    disabled={submitting || isLoading}
                    autoFocus={index === 0}
                  />
                  {index < pendingQuestions.length - 1 && (
                    <hr className="mt-4 border-border" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Helper panel column (conditional) */}
          {showHelperPanel && helperFeatureId && projectPath && (
            <div className="w-[380px] shrink-0 border-l pl-4 flex flex-col overflow-hidden min-h-0">
              <QuestionHelperPanel featureId={helperFeatureId} projectPath={projectPath} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting || isLoading}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitDisabled}>
            {submitting || isLoading ? (
              <>
                <Spinner className="mr-2 h-4 w-4" />
                Submitting...
              </>
            ) : pendingQuestions.length > 1 ? (
              'Submit All Answers'
            ) : (
              'Submit Answer'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
