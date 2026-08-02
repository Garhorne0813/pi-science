import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Eye, FileText, ListChecks, Loader2, MessageSquareText, PenLine, Send, Sparkles } from "lucide-react";
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
  const [activeIndex, setActiveIndex] = useState(0);
  const [review, setReview] = useState(false);
  const [answers, setAnswers] = useState<Array<QuestionnaireAnswer | null>>(() => emptyAnswers(questionnaire.questions));
  const [notes, setNotes] = useState<string[]>(() => questionnaire.questions.map(() => ""));
  const [customDrafts, setCustomDrafts] = useState<string[]>(() => questionnaire.questions.map(() => ""));
  const [customOpen, setCustomOpen] = useState<boolean[]>(() => questionnaire.questions.map(() => false));
  const [previewIndex, setPreviewIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setActiveIndex(0);
    setReview(false);
    setAnswers(emptyAnswers(questionnaire.questions));
    setNotes(questionnaire.questions.map(() => ""));
    setCustomDrafts(questionnaire.questions.map(() => ""));
    setCustomOpen(questionnaire.questions.map(() => false));
    setPreviewIndex(0);
    setSubmitting(false);
  }, [questionnaire.toolCallId]);

  const questions = questionnaire.questions;
  const current = questions[activeIndex] ?? questions[0];
  const currentAnswer = answers[activeIndex] ?? null;
  const previewOptions = useMemo(
    () => current?.options.filter((option) => Boolean(option.preview)) ?? [],
    [current],
  );
  const selectedPreview = current?.options[previewIndex]?.preview;
  const answeredCount = answers.filter(Boolean).length;
  const canSubmit = answeredCount === questions.length && !submitting;

  if (!current) return null;

  const updateAnswer = (index: number, answer: QuestionnaireAnswer | null) => {
    setAnswers((previous) => previous.map((item, itemIndex) => itemIndex === index ? answer : item));
  };

  const chooseOption = (optionIndex: number) => {
    const option = current.options[optionIndex];
    if (!option) return;
    if (current.multiSelect) {
      const previous = currentAnswer?.kind === "multi" ? currentAnswer.selected ?? [] : [];
      const selected = previous.includes(option.label)
        ? previous.filter((label) => label !== option.label)
        : [...previous, option.label];
      updateAnswer(activeIndex, {
        questionIndex: activeIndex,
        question: current.question,
        kind: "multi",
        answer: null,
        selected,
      });
      setCustomOpen((previous) => previous.map((value, index) => index === activeIndex ? false : value));
      return;
    }
    setPreviewIndex(optionIndex);
    updateAnswer(activeIndex, {
      questionIndex: activeIndex,
      question: current.question,
      kind: "option",
      answer: option.label,
      ...(option.preview ? { preview: option.preview } : {}),
    });
    setCustomOpen((previous) => previous.map((value, index) => index === activeIndex ? false : value));
  };

  const openCustomAnswer = () => {
    setCustomOpen((previous) => previous.map((value, index) => index === activeIndex ? true : value));
    if (currentAnswer?.kind === "custom") setCustomDrafts((previous) => previous.map((value, index) => index === activeIndex ? (currentAnswer.answer ?? value) : value));
  };

  const saveCustomAnswer = () => {
    updateAnswer(activeIndex, {
      questionIndex: activeIndex,
      question: current.question,
      kind: "custom",
      answer: customDrafts[activeIndex] ?? "",
    });
    setCustomOpen((previous) => previous.map((value, index) => index === activeIndex ? false : value));
  };

  const markEmptyMulti = () => {
    if (!current.multiSelect) return;
    updateAnswer(activeIndex, {
      questionIndex: activeIndex,
      question: current.question,
      kind: "multi",
      answer: null,
      selected: [],
    });
  };

  const goToQuestion = (index: number) => {
    setReview(false);
    setActiveIndex(Math.max(0, Math.min(index, questions.length - 1)));
    setPreviewIndex(0);
  };

  const next = () => {
    if (activeIndex < questions.length - 1) {
      goToQuestion(activeIndex + 1);
    } else {
      setReview(true);
    }
  };

  const previous = () => {
    if (review) {
      setReview(false);
      return;
    }
    if (activeIndex > 0) goToQuestion(activeIndex - 1);
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

  return (
    <section data-request-id={interaction.requestId} className="overflow-hidden rounded-card border border-accent/35 bg-surface shadow-card animate-fadeIn" aria-label={t("questionnaire.title")}>
      <div className="border-b border-faint bg-accent/5 px-4 py-3 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
              <Sparkles size={15} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-text">{t("questionnaire.title")}</div>
              <div className="mt-0.5 text-xs text-muted">{t("questionnaire.progress", { answered: answeredCount, total: questions.length })}</div>
            </div>
          </div>
          <button type="button" onClick={cancel} className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text">
            {t("common.cancel")}
          </button>
        </div>
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label={t("questionnaire.questions")}>
          {questions.map((question, index) => {
            const selected = !review && activeIndex === index;
            const answered = Boolean(answers[index]);
            return (
              <button
                key={`${question.header}-${index}`}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => goToQuestion(index)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
                  selected ? "border-accent bg-accent text-accent-fg" : answered ? "border-ok/40 bg-ok/10 text-ok" : "border-border bg-surface text-muted hover:border-accent/50 hover:text-text",
                )}
              >
                {answered ? <Check size={12} /> : <span className="font-mono text-[10px]">{index + 1}</span>}
                <span>{question.header || t("questionnaire.question", { number: index + 1 })}</span>
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={review}
            onClick={() => setReview(true)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
              review ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-muted hover:border-accent/50 hover:text-text",
            )}
          >
            <ListChecks size={12} />
            {t("questionnaire.review")}
          </button>
        </div>
      </div>

      {review ? (
        <div className="px-4 py-4 sm:px-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text">
            <ListChecks size={15} className="text-accent" />
            {t("questionnaire.reviewTitle")}
          </div>
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
          <p className="mt-3 text-xs text-muted">{t("questionnaire.reviewHint")}</p>
        </div>
      ) : (
        <div className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.72fr)]">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium uppercase tracking-[0.08em] text-accent">{current.header || t("questionnaire.question", { number: activeIndex + 1 })}</div>
            <h2 className="text-base font-semibold leading-snug text-text">{current.question}</h2>
            <p className="mt-1 text-xs text-muted">{current.multiSelect ? t("questionnaire.multiHint") : t("questionnaire.singleHint")}</p>

            <div className="mt-4 grid gap-2">
              {current.options.map((option, index) => {
                const selected = current.multiSelect
                  ? currentAnswer?.kind === "multi" && currentAnswer.selected?.includes(option.label)
                  : currentAnswer?.kind === "option" && currentAnswer.answer === option.label;
                return (
                  <button
                    key={`${option.label}-${index}`}
                    type="button"
                    aria-pressed={selected}
                    onMouseEnter={() => { if (option.preview) setPreviewIndex(index); }}
                    onClick={() => chooseOption(index)}
                    className={cn(
                      "group flex w-full items-start gap-3 rounded-input border px-3 py-2.5 text-left transition-colors",
                      selected ? "border-accent bg-accent/10 ring-1 ring-accent/25" : "border-border bg-surface hover:border-accent/55 hover:bg-accent/5",
                    )}
                  >
                    <span className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px]",
                      selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2 text-muted group-hover:border-accent/50",
                    )}>
                      {selected ? <Check size={13} /> : current.multiSelect ? <span /> : <span>{index + 1}</span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium text-text">
                        {option.label}
                        {option.preview && <Eye size={12} className="shrink-0 text-accent" aria-label={t("questionnaire.hasPreview")} />}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">{option.description}</span>
                    </span>
                  </button>
                );
              })}

              <button
                type="button"
                aria-pressed={currentAnswer?.kind === "custom" || customOpen[activeIndex]}
                onClick={openCustomAnswer}
                className={cn(
                  "flex w-full items-center gap-3 rounded-input border border-dashed px-3 py-2.5 text-left text-sm transition-colors",
                  currentAnswer?.kind === "custom" || customOpen[activeIndex] ? "border-accent bg-accent/10 text-text" : "border-border text-muted hover:border-accent/55 hover:text-text",
                )}
              >
                <PenLine size={15} className="ml-0.5 shrink-0 text-accent" />
                <span>{t("questionnaire.custom")}</span>
              </button>

              {current.multiSelect && (
                <button type="button" onClick={markEmptyMulti} className="self-start px-1 text-xs text-muted underline decoration-border underline-offset-2 hover:text-text">
                  {t("questionnaire.none")}
                </button>
              )}
            </div>

            {customOpen[activeIndex] && (
              <div className="mt-3 rounded-input border border-accent/30 bg-accent/5 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-text"><PenLine size={13} className="text-accent" />{t("questionnaire.customLabel")}</div>
                <textarea
                  autoFocus
                  value={customDrafts[activeIndex] ?? ""}
                  onChange={(event) => setCustomDrafts((previous) => previous.map((value, index) => index === activeIndex ? event.target.value : value))}
                  rows={3}
                  placeholder={t("questionnaire.customPlaceholder")}
                  className="w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" onClick={() => setCustomOpen((previous) => previous.map((value, index) => index === activeIndex ? false : value))} className="rounded-input px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2">{t("common.cancel")}</button>
                  <button type="button" onClick={saveCustomAnswer} className="rounded-input bg-accent px-2.5 py-1.5 text-xs text-accent-fg">{t("questionnaire.saveAnswer")}</button>
                </div>
              </div>
            )}

            <div className="mt-4 rounded-input border border-border bg-surface-2/35 p-3">
              <label className="flex items-center gap-1.5 text-xs font-medium text-text" htmlFor={`questionnaire-notes-${activeIndex}`}>
                <MessageSquareText size={13} className="text-accent" />
                {t("questionnaire.notes")}
              </label>
              <textarea
                id={`questionnaire-notes-${activeIndex}`}
                value={notes[activeIndex] ?? ""}
                onChange={(event) => setNotes((previous) => previous.map((value, index) => index === activeIndex ? event.target.value : value))}
                rows={2}
                placeholder={t("questionnaire.notesPlaceholder")}
                className="mt-2 w-full resize-y rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </div>
          </div>

          <aside className="min-w-0 rounded-input border border-border bg-surface-2/35 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-text"><FileText size={13} className="text-accent" />{t("questionnaire.preview")}</div>
            {previewOptions.length > 0 ? (
              <div className="mt-2">
                <div className="mb-2 flex flex-wrap gap-1">
                  {current.options.map((option, index) => option.preview && (
                    <button key={`${option.label}-preview`} type="button" onClick={() => setPreviewIndex(index)} className={cn("rounded-full px-2 py-1 text-[10px]", previewIndex === index ? "bg-accent text-accent-fg" : "bg-surface text-muted hover:text-text")}>
                      {option.label}
                    </button>
                  ))}
                </div>
                {selectedPreview ? (
                  <div className="max-h-[280px] overflow-auto rounded-input border border-border bg-surface px-3 py-2">
                    <MarkdownViewer>{selectedPreview}</MarkdownViewer>
                  </div>
                ) : (
                  <div className="flex min-h-32 items-center justify-center rounded-input border border-dashed border-border px-4 text-center text-xs text-muted">{t("questionnaire.previewHint")}</div>
                )}
              </div>
            ) : (
              <div className="mt-2 flex min-h-32 items-center justify-center rounded-input border border-dashed border-border px-4 text-center text-xs text-muted">{t("questionnaire.noPreview")}</div>
            )}
          </aside>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-faint px-4 py-3 sm:px-5">
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {review ? t("questionnaire.readyToSubmit", { answered: answeredCount, total: questions.length }) : t("questionnaire.navigationHint")}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={previous} disabled={!review && activeIndex === 0} className="inline-flex items-center gap-1 rounded-input border border-border px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 disabled:opacity-40">
            <ChevronLeft size={14} />{t("common.back")}
          </button>
          {review ? (
            <button type="button" onClick={submit} disabled={!canSubmit} className="inline-flex items-center gap-1.5 rounded-input bg-accent px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50">
              {submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              {submitting ? t("questionnaire.submitting") : t("questionnaire.submit")}
            </button>
          ) : (
            <button type="button" onClick={next} className="inline-flex items-center gap-1 rounded-input bg-accent px-3 py-1.5 text-xs text-accent-fg">
              {activeIndex === questions.length - 1 ? t("questionnaire.review") : t("common.next")}<ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
