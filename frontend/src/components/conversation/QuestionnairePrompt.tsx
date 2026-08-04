import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Eye, ListChecks, Loader2, MessageSquareText, PenLine, Send, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { cn } from "../../lib/ui";
import type { PendingInteraction, PendingQuestionnaire, QuestionnaireQuestion } from "../../lib/agent-runtime";

type QuestionnaireAnswer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
};

type InteractionResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };

function emptyAnswers(questions: QuestionnaireQuestion[]): Array<QuestionnaireAnswer | null> {
  return questions.map(() => null);
}

function answerLabel(answer: QuestionnaireAnswer | null): string {
  if (!answer) return "";
  if (answer.kind === "multi") return answer.selected?.length ? answer.selected.join(", ") : "(none)";
  return answer.answer || "(custom answer)";
}

/** Accordion questionnaire: all questions stacked, one open at a time, inline
 *  option previews, collapsible notes, a summary toggle and a persistent
 *  submit button. Component API, data-request-id and the submit payload are
 *  unchanged from the previous tabbed design. */
export function QuestionnairePrompt({
  questionnaire,
  interaction,
  onRespond,
}: {
  questionnaire: PendingQuestionnaire;
  interaction: PendingInteraction;
  onRespond: (response: InteractionResponse) => void;
}) {
  const { t } = useTranslation();
  const [openIndex, setOpenIndex] = useState(0);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [answers, setAnswers] = useState<Array<QuestionnaireAnswer | null>>(() => emptyAnswers(questionnaire.questions));
  const [notes, setNotes] = useState<string[]>(() => questionnaire.questions.map(() => ""));
  const [notesOpen, setNotesOpen] = useState<boolean[]>(() => questionnaire.questions.map(() => false));
  const [customDrafts, setCustomDrafts] = useState<string[]>(() => questionnaire.questions.map(() => ""));
  const [customOpen, setCustomOpen] = useState<boolean[]>(() => questionnaire.questions.map(() => false));
  const [hoveredOption, setHoveredOption] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setOpenIndex(0);
    setSummaryOpen(false);
    setAnswers(emptyAnswers(questionnaire.questions));
    setNotes(questionnaire.questions.map(() => ""));
    setNotesOpen(questionnaire.questions.map(() => false));
    setCustomDrafts(questionnaire.questions.map(() => ""));
    setCustomOpen(questionnaire.questions.map(() => false));
    setHoveredOption(null);
    setSubmitting(false);
  }, [questionnaire.toolCallId]);

  const questions = questionnaire.questions;
  if (questions.length === 0) return null;

  const answeredCount = answers.filter(Boolean).length;
  const canSubmit = answeredCount === questions.length && !submitting;

  const updateAnswer = (index: number, answer: QuestionnaireAnswer | null) => {
    setAnswers((previous) => previous.map((item, itemIndex) => itemIndex === index ? answer : item));
  };

  // After the FIRST answer to a question, open the first unanswered one so an
  // out-of-order answer still returns to the earliest incomplete question.
  const advanceIfFirstAnswer = (index: number, wasAnswered: boolean, nextAnswer: QuestionnaireAnswer) => {
    if (wasAnswered) return;
    const nextAnswers = answers.map((answer, itemIndex) => itemIndex === index ? nextAnswer : answer);
    const nextUnanswered = nextAnswers.findIndex((answer) => !answer);
    if (nextUnanswered >= 0) {
      setSummaryOpen(false);
      setOpenIndex(nextUnanswered);
    } else {
      setSummaryOpen(true);
    }
  };

  const chooseOption = (optionIndex: number) => {
    const question = questions[openIndex];
    const option = question.options[optionIndex];
    if (!option) return;
    const wasAnswered = Boolean(answers[openIndex]);
    if (question.multiSelect) {
      const previous = answers[openIndex]?.kind === "multi" ? answers[openIndex].selected ?? [] : [];
      const selected = previous.includes(option.label)
        ? previous.filter((label) => label !== option.label)
        : [...previous, option.label];
      updateAnswer(openIndex, {
        questionIndex: openIndex,
        question: question.question,
        kind: "multi",
        answer: null,
        selected,
      });
      setCustomOpen((previous) => previous.map((value, index) => index === openIndex ? false : value));
      return;
    }
    const nextAnswer: QuestionnaireAnswer = {
      questionIndex: openIndex,
      question: question.question,
      kind: "option",
      answer: option.label,
      ...(option.preview ? { preview: option.preview } : {}),
    };
    updateAnswer(openIndex, nextAnswer);
    setCustomOpen((previous) => previous.map((value, index) => index === openIndex ? false : value));
    advanceIfFirstAnswer(openIndex, wasAnswered, nextAnswer);
  };

  const toggleCustomAnswer = (index: number) => {
    const isOpen = Boolean(customOpen[index]);
    setCustomOpen((previous) => previous.map((value, itemIndex) => itemIndex === index ? !value : value));
    if (!isOpen && answers[index]?.kind === "custom") {
      setCustomDrafts((previous) => previous.map((value, itemIndex) => itemIndex === index ? (answers[index]?.answer ?? value) : value));
    }
  };

  const cancelCustomAnswer = (index: number) => {
    setCustomDrafts((previous) => previous.map((value, itemIndex) => itemIndex === index ? "" : value));
    setCustomOpen((previous) => previous.map((value, itemIndex) => itemIndex === index ? false : value));
  };

  const saveCustomAnswer = (index: number) => {
    const question = questions[index];
    const wasAnswered = Boolean(answers[index]);
    const nextAnswer: QuestionnaireAnswer = {
      questionIndex: index,
      question: question.question,
      kind: "custom",
      answer: customDrafts[index] ?? "",
    };
    updateAnswer(index, nextAnswer);
    setCustomOpen((previous) => previous.map((value, itemIndex) => itemIndex === index ? false : value));
    advanceIfFirstAnswer(index, wasAnswered, nextAnswer);
  };

  const markEmptyMulti = () => {
    const question = questions[openIndex];
    if (!question.multiSelect) return;
    const wasAnswered = Boolean(answers[openIndex]);
    const nextAnswer: QuestionnaireAnswer = {
      questionIndex: openIndex,
      question: question.question,
      kind: "multi",
      answer: null,
      selected: [],
    };
    updateAnswer(openIndex, nextAnswer);
    advanceIfFirstAnswer(openIndex, wasAnswered, nextAnswer);
  };

  const toggleQuestion = (index: number) => {
    setSummaryOpen(false);
    setOpenIndex((previous) => previous === index ? -1 : index);
    setHoveredOption(null);
  };

  const goToQuestion = (index: number) => {
    setSummaryOpen(false);
    setOpenIndex(Math.max(0, Math.min(index, questions.length - 1)));
    setHoveredOption(null);
  };

  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const payload = {
      cancelled: false,
      answers: answers.flatMap((answer, index) => answer ? [{ ...answer, notes: notes[index]?.trim() || undefined }] : []),
    };
    onRespond({ value: JSON.stringify(payload) });
  };

  const cancel = () => onRespond({ cancelled: true });
  const componentId = interaction.requestId.replace(/[^a-zA-Z0-9_-]/g, "-");

  return (
    <section data-request-id={interaction.requestId} className="overflow-hidden rounded-card border border-accent/35 bg-surface shadow-card animate-fadeIn" aria-label={t("questionnaire.title")}>
      <div className="border-b border-faint bg-accent/5 px-4 py-3 sm:px-5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text">{t("questionnaire.title")}</div>
            <div className="mt-0.5 text-xs text-muted">{t("questionnaire.progress", { answered: answeredCount, total: questions.length })}</div>
          </div>
        </div>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={t("questionnaire.progress", { answered: answeredCount, total: questions.length })} aria-valuemin={0} aria-valuemax={questions.length} aria-valuenow={answeredCount}>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
        </div>
      </div>

      {/* Accordion: every question is visible, one expanded at a time. */}
      <div className="flex flex-col divide-y divide-faint">
        {questions.map((question, index) => {
          const open = openIndex === index;
          const answered = Boolean(answers[index]);
          const currentAnswer = answers[index] ?? null;
          const headerId = `questionnaire-header-${componentId}-${index}`;
          const panelId = `questionnaire-panel-${componentId}-${index}`;
          return (
            <div key={`${question.header}-${index}`} className={cn(open && "bg-surface-2/25")}>
              <button
                id={headerId}
                type="button"
                onClick={() => toggleQuestion(index)}
                aria-expanded={open}
                aria-controls={panelId}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
              >
                <span className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]",
                  answered ? "bg-ok/15 text-ok" : "bg-surface-2 text-muted",
                )}>
                  {answered ? <Check size={12} /> : <span className="font-mono">{index + 1}</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted">{question.header || t("questionnaire.question", { number: index + 1 })}</span>
                  <span className="block truncate text-sm font-medium text-text">{question.question}</span>
                </span>
                <ChevronDown size={14} className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")} />
              </button>

              <div id={panelId} role="region" aria-labelledby={headerId} hidden={!open} className="px-4 pb-4 sm:px-5">
                {open && (
                  <div className="mt-1 grid gap-2">
                    {question.options.map((option, optionIndex) => {
                      const selected = question.multiSelect
                        ? currentAnswer?.kind === "multi" && currentAnswer.selected?.includes(option.label)
                        : currentAnswer?.kind === "option" && currentAnswer.answer === option.label;
                      const showPreview = option.preview && (hoveredOption === optionIndex || (hoveredOption === null && selected));
                      return (
                        <div key={`${option.label}-${optionIndex}`}>
                          <button
                            type="button"
                            aria-pressed={selected}
                            onMouseEnter={() => { if (option.preview) setHoveredOption(optionIndex); }}
                            onMouseLeave={() => setHoveredOption(null)}
                            onClick={() => chooseOption(optionIndex)}
                            className={cn(
                              "group flex w-full items-start gap-3 rounded-input border px-3 py-2.5 text-left transition-colors",
                              selected ? "border-accent bg-accent/10 ring-1 ring-accent/25" : "border-border bg-surface hover:border-accent/55 hover:bg-accent/5",
                            )}
                          >
                            <span className={cn(
                              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px]",
                              selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2 text-muted group-hover:border-accent/50",
                            )}>
                              {selected ? <Check size={13} /> : question.multiSelect ? <span /> : <span>{optionIndex + 1}</span>}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2 text-sm font-medium text-text">
                                {option.label}
                                {option.preview && <Eye size={12} className="shrink-0 text-accent" aria-label={t("questionnaire.hasPreview")} />}
                              </span>
                              <span className="mt-0.5 block text-xs leading-relaxed text-muted">{option.description}</span>
                            </span>
                          </button>
                          {showPreview && option.preview && (
                            <div className="mt-2 rounded-input border border-border bg-surface px-3 py-2">
                              <MarkdownViewer>{option.preview}</MarkdownViewer>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      aria-expanded={customOpen[index]}
                      aria-pressed={customOpen[index]}
                      onClick={() => toggleCustomAnswer(index)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-input border border-dashed px-3 py-2.5 text-left text-sm transition-colors",
                        currentAnswer?.kind === "custom" || customOpen[index] ? "border-accent bg-accent/10 text-text" : "border-border text-muted hover:border-accent/55 hover:text-text",
                      )}
                    >
                      <PenLine size={15} className="ml-0.5 shrink-0 text-accent" />
                      <span>{t("questionnaire.custom")}</span>
                    </button>

                    {customOpen[index] && (
                      <div className="rounded-input border border-accent/30 bg-accent/5 p-3">
                        <label htmlFor={`questionnaire-custom-${componentId}-${index}`} className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-text"><PenLine size={13} className="text-accent" />{t("questionnaire.customLabel")}</label>
                        <textarea
                          id={`questionnaire-custom-${componentId}-${index}`}
                          autoFocus
                          value={customDrafts[index] ?? ""}
                          onChange={(event) => setCustomDrafts((previous) => previous.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}
                          rows={3}
                          placeholder={t("questionnaire.customPlaceholder")}
                          className="w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <button type="button" onClick={() => cancelCustomAnswer(index)} className="rounded-input px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2">{t("common.cancel")}</button>
                          <button type="button" onClick={() => saveCustomAnswer(index)} className="rounded-input bg-accent px-2.5 py-1.5 text-xs text-accent-fg">{t("questionnaire.saveAnswer")}</button>
                        </div>
                      </div>
                    )}

                    {question.multiSelect && (
                      <button type="button" onClick={markEmptyMulti} className="self-start px-1 text-xs text-muted underline decoration-border underline-offset-2 hover:text-text">
                        {t("questionnaire.none")}
                      </button>
                    )}

                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() => setNotesOpen((previous) => previous.map((value, itemIndex) => itemIndex === index ? !value : value))}
                        aria-expanded={notesOpen[index]}
                        className="inline-flex items-center gap-1.5 rounded-input px-1 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
                      >
                        <MessageSquareText size={13} className="text-accent" />
                        {t("questionnaire.notes")}
                        {Boolean(notes[index]?.trim()) && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                      </button>
                      {notesOpen[index] && (
                        <>
                          <label htmlFor={`questionnaire-notes-${componentId}-${index}`} className="sr-only">{t("questionnaire.notes")}</label>
                          <textarea
                            id={`questionnaire-notes-${componentId}-${index}`}
                            value={notes[index] ?? ""}
                            onChange={(event) => setNotes((previous) => previous.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}
                            rows={2}
                            placeholder={t("questionnaire.notesPlaceholder")}
                            className="mt-2 w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                          />
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Collapsible answer summary — clicking a row jumps back to the question. */}
      {summaryOpen && (
        <div className="border-t border-faint px-4 py-3 sm:px-5">
          <div className="space-y-2">
            {questions.map((question, index) => (
              <button
                key={`${question.question}-${index}`}
                type="button"
                onClick={() => goToQuestion(index)}
                className="flex w-full items-start justify-between gap-4 rounded-input border border-border bg-surface-2/40 px-3 py-2.5 text-left hover:border-accent/50"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-muted">{question.header || t("questionnaire.question", { number: index + 1 })}</span>
                  <span className="mt-0.5 block truncate text-sm text-text">{question.question}</span>
                </span>
                <span className={cn("shrink-0 text-xs", answers[index] ? "text-ok" : "text-warn")}>
                  {answers[index] ? answerLabel(answers[index]) : t("questionnaire.unanswered")}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-faint px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSummaryOpen((value) => !value)}
            className="inline-flex items-center gap-1 rounded-input border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
          >
            {summaryOpen ? <ChevronUp size={14} /> : <ListChecks size={14} />}
            {summaryOpen ? t("questionnaire.hideReview") : t("questionnaire.review")}
          </button>
          <span className="text-[11px] text-muted">{t("questionnaire.readyToSubmit", { answered: answeredCount, total: questions.length })}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={cancel} className="rounded-input px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text">
            {t("common.cancel")}
          </button>
          <button type="button" onClick={submit} disabled={!canSubmit} className="inline-flex items-center gap-1.5 rounded-input bg-accent px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50">
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            {submitting ? t("questionnaire.submitting") : t("questionnaire.submit")}
          </button>
        </div>
      </div>
    </section>
  );
}
