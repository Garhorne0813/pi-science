import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Eye, ListChecks, Loader2, MessageSquareText, PenLine, Send, Sparkles } from "lucide-react";
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

function answerLabel(answer: QuestionnaireAnswer | null, noneLabel: string, customLabel: string): string {
  if (!answer) return "";
  if (answer.kind === "multi") return answer.selected?.length ? answer.selected.join(", ") : noneLabel;
  return answer.answer || customLabel;
}

function replaceAt<T>(values: T[], index: number, value: T): T[] {
  return values.map((current, currentIndex) => currentIndex === index ? value : current);
}

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
  const questions = questionnaire.questions;
  const [openIndex, setOpenIndex] = useState(0);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [answers, setAnswers] = useState<Array<QuestionnaireAnswer | null>>(() => emptyAnswers(questions));
  const [notes, setNotes] = useState<string[]>(() => questions.map(() => ""));
  const [notesOpen, setNotesOpen] = useState<boolean[]>(() => questions.map(() => false));
  const [customDrafts, setCustomDrafts] = useState<string[]>(() => questions.map(() => ""));
  const [customOpen, setCustomOpen] = useState<boolean[]>(() => questions.map(() => false));
  const [hoveredOption, setHoveredOption] = useState<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
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
    setPreviewIndex(null);
    setSubmitting(false);
  }, [questionnaire.toolCallId, questionnaire.questions]);

  if (questions.length === 0) return null;

  const answeredCount = answers.filter(Boolean).length;
  const canSubmit = answeredCount === questions.length && !submitting;
  const noneLabel = t("questionnaire.none");
  const customLabel = t("questionnaire.custom");
  const componentId = interaction.requestId.replace(/[^a-zA-Z0-9_-]/g, "-");

  const updateAnswer = (index: number, answer: QuestionnaireAnswer | null) => {
    setAnswers((previous) => replaceAt(previous, index, answer));
  };

  const openQuestion = (index: number) => {
    setSummaryOpen(false);
    setOpenIndex(Math.max(0, Math.min(index, questions.length - 1)));
    setHoveredOption(null);
    setPreviewIndex(null);
  };

  const openNextUnanswered = (fromIndex: number) => {
    // Always return to the first incomplete question, even when the user
    // answered a later accordion row out of order.
    const nextIndex = questions.findIndex((_, index) => index !== fromIndex && !answers[index]);
    if (nextIndex >= 0) openQuestion(nextIndex);
    else setSummaryOpen(true);
  };

  const chooseOption = (questionIndex: number, optionIndex: number) => {
    const question = questions[questionIndex];
    const option = question?.options[optionIndex];
    if (!question || !option) return;

    const previousAnswer = answers[questionIndex] ?? null;
    if (question.multiSelect) {
      const previous = previousAnswer?.kind === "multi" ? previousAnswer.selected ?? [] : [];
      const selected = previous.includes(option.label)
        ? previous.filter((label) => label !== option.label)
        : [...previous, option.label];
      updateAnswer(questionIndex, {
        questionIndex,
        question: question.question,
        kind: "multi",
        answer: null,
        selected,
      });
      if (option.preview) setPreviewIndex(optionIndex);
      if (!selected.includes(option.label) && previewIndex === optionIndex) setPreviewIndex(null);
      setHoveredOption(null);
      setCustomOpen((previous) => replaceAt(previous, questionIndex, false));
      return;
    }

    updateAnswer(questionIndex, {
      questionIndex,
      question: question.question,
      kind: "option",
      answer: option.label,
      ...(option.preview ? { preview: option.preview } : {}),
    });
    setPreviewIndex(option.preview ? optionIndex : null);
    setHoveredOption(null);
    setCustomOpen((previous) => replaceAt(previous, questionIndex, false));
    if (!previousAnswer) openNextUnanswered(questionIndex);
  };

  const toggleCustomAnswer = (questionIndex: number) => {
    const isOpen = Boolean(customOpen[questionIndex]);
    const existingAnswer = answers[questionIndex];
    setCustomOpen((previous) => replaceAt(previous, questionIndex, !isOpen));
    if (!isOpen && existingAnswer?.kind === "custom") {
      setCustomDrafts((previous) => replaceAt(previous, questionIndex, existingAnswer.answer ?? ""));
    }
    setHoveredOption(null);
    setPreviewIndex(null);
  };

  const cancelCustomAnswer = (questionIndex: number) => {
    setCustomDrafts((previous) => replaceAt(previous, questionIndex, ""));
    setCustomOpen((previous) => replaceAt(previous, questionIndex, false));
  };

  const saveCustomAnswer = (questionIndex: number) => {
    const question = questions[questionIndex];
    if (!question) return;
    const wasAnswered = Boolean(answers[questionIndex]);
    updateAnswer(questionIndex, {
      questionIndex,
      question: question.question,
      kind: "custom",
      answer: customDrafts[questionIndex] ?? "",
    });
    setCustomOpen((previous) => replaceAt(previous, questionIndex, false));
    setHoveredOption(null);
    setPreviewIndex(null);
    if (!wasAnswered) openNextUnanswered(questionIndex);
  };

  const markEmptyMulti = (questionIndex: number) => {
    const question = questions[questionIndex];
    if (!question?.multiSelect) return;
    const wasAnswered = Boolean(answers[questionIndex]);
    updateAnswer(questionIndex, {
      questionIndex,
      question: question.question,
      kind: "multi",
      answer: null,
      selected: [],
    });
    setCustomOpen((previous) => replaceAt(previous, questionIndex, false));
    setHoveredOption(null);
    setPreviewIndex(null);
    if (!wasAnswered) openNextUnanswered(questionIndex);
  };

  const selectedPreviewIndex = (question: QuestionnaireQuestion, questionIndex: number): number | null => {
    const answer = answers[questionIndex];
    if (answer?.kind === "option") {
      const index = question.options.findIndex((option) => option.label === answer.answer && option.preview);
      return index >= 0 ? index : null;
    }
    if (answer?.kind === "multi") {
      const selected = new Set(answer.selected ?? []);
      if (previewIndex !== null && selected.has(question.options[previewIndex]?.label ?? "") && question.options[previewIndex]?.preview) {
        return previewIndex;
      }
      const index = question.options.findIndex((option) => selected.has(option.label) && option.preview);
      return index >= 0 ? index : null;
    }
    return null;
  };

  const previewVisibleFor = (question: QuestionnaireQuestion, questionIndex: number, optionIndex: number): boolean => {
    if (!question.options[optionIndex]?.preview) return false;
    if (hoveredOption !== null) return hoveredOption === optionIndex;
    return selectedPreviewIndex(question, questionIndex) === optionIndex || previewIndex === optionIndex;
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

  const previous = () => {
    if (summaryOpen) {
      setSummaryOpen(false);
      return;
    }
    if (openIndex > 0) openQuestion(openIndex - 1);
  };

  const next = () => {
    if (openIndex < questions.length - 1) openQuestion(openIndex + 1);
  };

  return (
    <section data-request-id={interaction.requestId} className="overflow-hidden rounded-card border border-accent/35 bg-surface shadow-card animate-fadeIn" aria-label={t("questionnaire.title")}>
      <header className="border-b border-faint bg-accent/5 px-4 py-2 sm:px-5">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
            <Sparkles size={13} />
          </span>
          <div className="min-w-0 text-sm font-semibold text-text">{t("questionnaire.title")}</div>
        </div>
        <div
          className="mt-1 overflow-hidden rounded-full bg-accent/15"
          role="progressbar"
          aria-label={t("questionnaire.progress", { answered: answeredCount, total: questions.length })}
          aria-valuemin={0}
          aria-valuemax={questions.length}
          aria-valuenow={answeredCount}
        >
          <div className="h-1 rounded-full bg-accent transition-[width]" style={{ width: `${(answeredCount / questions.length) * 100}%` }} />
        </div>
      </header>

      <div className="space-y-1.5 px-3 py-1.5 sm:px-4">
        {questions.map((question, questionIndex) => {
          const isOpen = openIndex === questionIndex;
          const answer = answers[questionIndex] ?? null;
          const answered = Boolean(answer);
          const questionLabel = question.header || t("questionnaire.question", { number: questionIndex + 1 });

          return (
            <div key={`${question.question}-${questionIndex}`} className={cn("overflow-hidden rounded-input border transition-colors", isOpen ? "border-accent/35 bg-surface" : "border-border bg-surface-2/20")}>
              <button
                id={`questionnaire-header-${componentId}-${questionIndex}`}
                type="button"
                aria-expanded={isOpen}
                aria-controls={`questionnaire-panel-${componentId}-${questionIndex}`}
                onClick={() => openQuestion(questionIndex)}
                className="flex w-full items-start gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/5 sm:px-3"
              >
                <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", answered ? "bg-ok/10 text-ok" : "bg-accent/10 text-accent")}>
                  {answered ? <Check size={13} /> : questionIndex + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-medium uppercase tracking-[0.06em] text-accent">{questionLabel}</span>
                  <span className="block truncate text-sm font-medium leading-snug text-text">{question.question}</span>
                  {!isOpen && answered && (
                    <span className="mt-0.5 block truncate text-xs text-muted">{answerLabel(answer, noneLabel, customLabel)}</span>
                  )}
                </span>
                <ChevronDown size={16} className={cn("mt-1 shrink-0 text-muted transition-transform", isOpen && "rotate-180 text-accent")} />
              </button>

              {isOpen && (
                <div
                  id={`questionnaire-panel-${componentId}-${questionIndex}`}
                  role="region"
                  aria-labelledby={`questionnaire-header-${componentId}-${questionIndex}`}
                  className="px-2.5 pb-2.5 sm:px-3"
                >
                  <div className="grid gap-1.5">
                    {question.options.map((option, optionIndex) => {
                      const selected = question.multiSelect
                        ? answer?.kind === "multi" && answer.selected?.includes(option.label)
                        : answer?.kind === "option" && answer.answer === option.label;
                      const showPreview = previewVisibleFor(question, questionIndex, optionIndex);

                      return (
                        <div
                          key={`${option.label}-${optionIndex}`}
                          onMouseEnter={() => { if (option.preview) setHoveredOption(optionIndex); }}
                          onMouseLeave={() => setHoveredOption(null)}
                        >
                          <button
                            type="button"
                            aria-pressed={Boolean(selected)}
                            onFocus={() => { if (option.preview) setHoveredOption(optionIndex); }}
                            onBlur={() => setHoveredOption(null)}
                            onClick={() => chooseOption(questionIndex, optionIndex)}
                            className={cn(
                              "group flex w-full items-start gap-2.5 rounded-input border px-2.5 py-1.5 text-left transition-colors",
                              selected ? "border-accent bg-accent/10 ring-1 ring-accent/25" : "border-border bg-surface hover:border-accent/55 hover:bg-accent/5",
                            )}
                          >
                            <span className={cn(
                              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-[10px]",
                              question.multiSelect ? "rounded" : "rounded-full",
                              selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2 text-muted group-hover:border-accent/50",
                            )}>
                              {question.multiSelect
                                ? selected && <Check size={11} />
                                : selected && <span className="h-1.5 w-1.5 rounded-full bg-accent-fg" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                                <span className="truncate">{option.label}</span>
                                {option.preview && (
                                  <span className="shrink-0 text-accent">
                                    <Eye size={12} aria-label={t("questionnaire.hasPreview")} />
                                  </span>
                                )}
                              </span>
                              {option.description && <span className="mt-0.5 block text-xs leading-snug text-muted">{option.description}</span>}
                            </span>
                          </button>
                          {showPreview && option.preview && (
                            <div className="mt-1 max-h-44 overflow-auto rounded-input border border-accent/25 bg-accent/5 px-2.5 py-1.5 text-xs text-text">
                              <MarkdownViewer>{option.preview}</MarkdownViewer>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      aria-expanded={customOpen[questionIndex]}
                      aria-pressed={answer?.kind === "custom" || customOpen[questionIndex]}
                      onClick={() => toggleCustomAnswer(questionIndex)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-input border border-dashed px-2.5 py-1.5 text-left text-sm transition-colors",
                        answer?.kind === "custom" || customOpen[questionIndex] ? "border-accent bg-accent/10 text-text" : "border-border text-muted hover:border-accent/55 hover:text-text",
                      )}
                    >
                      <PenLine size={14} className="ml-0.5 shrink-0 text-accent" />
                      <span className="truncate">{t("questionnaire.custom")}</span>
                    </button>

                    {question.multiSelect && (
                      <button type="button" onClick={() => markEmptyMulti(questionIndex)} className="self-start px-1 text-xs text-muted underline decoration-border underline-offset-2 hover:text-text">
                        {t("questionnaire.none")}
                      </button>
                    )}
                  </div>

                  {customOpen[questionIndex] && (
                    <div className="mt-2 rounded-input border border-accent/30 bg-accent/5 p-2.5">
                      <label htmlFor={`questionnaire-custom-${componentId}-${questionIndex}`} className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text"><PenLine size={12} className="text-accent" />{t("questionnaire.customLabel")}</label>
                      <textarea
                        id={`questionnaire-custom-${componentId}-${questionIndex}`}
                        autoFocus
                        value={customDrafts[questionIndex] ?? ""}
                        onChange={(event) => setCustomDrafts((previous) => replaceAt(previous, questionIndex, event.target.value))}
                        rows={2}
                        placeholder={t("questionnaire.customPlaceholder")}
                        className="w-full resize-y rounded-input border border-border bg-surface px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
                      />
                      <div className="mt-1.5 flex justify-end gap-1.5">
                        <button type="button" onClick={() => cancelCustomAnswer(questionIndex)} className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2">{t("common.cancel")}</button>
                        <button type="button" onClick={() => saveCustomAnswer(questionIndex)} className="rounded-input bg-accent px-2.5 py-1 text-xs text-accent-fg">{t("questionnaire.saveAnswer")}</button>
                      </div>
                    </div>
                  )}

                  <div className="mt-2">
                    <button
                      type="button"
                      aria-expanded={notesOpen[questionIndex]}
                      onClick={() => setNotesOpen((previous) => replaceAt(previous, questionIndex, !previous[questionIndex]))}
                      className="flex max-w-full items-center gap-1.5 rounded-input px-1 py-0.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
                    >
                      <MessageSquareText size={12} className="shrink-0 text-accent" />
                      {notes[questionIndex]?.trim() && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
                      <span className="truncate">{notes[questionIndex]?.trim() || t("questionnaire.notes")}</span>
                    </button>
                    {notesOpen[questionIndex] && (
                      <div className="mt-1.5">
                        <label className="sr-only" htmlFor={`questionnaire-notes-${componentId}-${questionIndex}`}>{t("questionnaire.notes")}</label>
                        <textarea
                          id={`questionnaire-notes-${componentId}-${questionIndex}`}
                          value={notes[questionIndex] ?? ""}
                          onChange={(event) => setNotes((previous) => replaceAt(previous, questionIndex, event.target.value))}
                          rows={2}
                          placeholder={t("questionnaire.notesPlaceholder")}
                          className="w-full resize-y rounded-input border border-border bg-surface-2/35 px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <footer className="border-t border-faint">
        <div className="px-4 pt-1.5 sm:px-5">
          <button
            type="button"
            aria-label={summaryOpen ? t("questionnaire.hideReview") : t("questionnaire.review")}
            aria-expanded={summaryOpen}
            onClick={() => setSummaryOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 rounded-input px-1 py-1 text-left text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            <ListChecks size={13} className="text-accent" />
            <span>{summaryOpen ? t("questionnaire.hideReview") : t("questionnaire.review")}</span>
            <span className="text-[11px] text-muted">{t("questionnaire.progress", { answered: answeredCount, total: questions.length })}</span>
            <ChevronDown size={14} className={cn("ml-auto transition-transform", summaryOpen && "rotate-180")} />
          </button>
        </div>

        {summaryOpen && (
          <div className="space-y-1 px-4 pb-1.5 pt-1 sm:px-5">
            {questions.map((question, questionIndex) => {
              const answer = answers[questionIndex] ?? null;
              return (
                <button
                  key={`${question.question}-summary-${questionIndex}`}
                  type="button"
                  onClick={() => openQuestion(questionIndex)}
                  className="flex w-full items-start gap-2 rounded-input border border-border bg-surface-2/35 px-2.5 py-1.5 text-left transition-colors hover:border-accent/50"
                >
                  <span className="w-5 shrink-0 text-[11px] font-mono text-muted">{questionIndex + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-text">{question.header || t("questionnaire.question", { number: questionIndex + 1 })}</span>
                    <span className="block truncate text-xs text-text">{question.question}</span>
                    <span className="block truncate text-xs text-muted">{answer ? answerLabel(answer, noneLabel, customLabel) : t("questionnaire.unanswered")}</span>
                  </span>
                  {answer ? <Check size={13} className="mt-0.5 shrink-0 text-ok" /> : <span className="mt-0.5 shrink-0 text-[11px] text-warn">—</span>}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-5">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={previous} disabled={openIndex === 0 && !summaryOpen} className="inline-flex items-center gap-1 rounded-input border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 disabled:opacity-40">
              <ChevronLeft size={13} />{t("common.back")}
            </button>
            <button type="button" onClick={next} disabled={openIndex === questions.length - 1} className="inline-flex items-center gap-1 rounded-input border border-border px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-2 disabled:opacity-40">
              {t("common.next")}<ChevronRight size={13} />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => onRespond({ cancelled: true })} className="inline-flex items-center rounded-input border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={submit} disabled={!canSubmit} className="inline-flex items-center gap-1.5 rounded-input bg-accent px-3 py-1 text-xs text-accent-fg disabled:opacity-50">
              {submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {submitting ? t("questionnaire.submitting") : t("questionnaire.submit")}
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}
