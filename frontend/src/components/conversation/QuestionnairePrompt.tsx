import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ListChecks, Loader2, MessageSquareText, PenLine, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import type { PendingInteraction, PendingQuestionnaire } from "../../lib/agent-runtime";
import { QuestionnaireOptionDetails } from "./QuestionnaireOptionDetails";

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
type Props = {
  questionnaire: PendingQuestionnaire;
  interaction: PendingInteraction;
  onRespond: (response: InteractionResponse) => void | Promise<void>;
  onProgress?: (answered: number) => void;
  onCollapse?: () => void;
  active?: boolean;
};
function replaceAt<T>(values: T[], index: number, value: T): T[] {
  return values.map((current, currentIndex) => currentIndex === index ? value : current);
}
function answerLabel(answer: QuestionnaireAnswer | null, noneLabel: string): string {
  if (!answer) return "";
  return answer.kind === "multi" ? answer.selected?.join(", ") || noneLabel : answer.answer || "";
}
export function QuestionnairePrompt(props: Props) {
  return <QuestionnaireForm key={JSON.stringify([props.interaction.requestId, props.questionnaire.toolCallId])} {...props} />;
}
function QuestionnaireForm({ questionnaire, interaction, onRespond, onProgress, onCollapse, active = true }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const questions = questionnaire.questions;
  const [index, setIndex] = useState(0);
  const [review, setReview] = useState(false);
  const [answers, setAnswers] = useState<Array<QuestionnaireAnswer | null>>(() => questions.map(() => null));
  const [notes, setNotes] = useState<string[]>(() => questions.map(() => ""));
  const [notesOpen, setNotesOpen] = useState<boolean[]>(() => questions.map(() => false));
  const [drafts, setDrafts] = useState<string[]>(() => questions.map(() => ""));
  const [customOpen, setCustomOpen] = useState<boolean[]>(() => questions.map(() => false));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const answeredCount = answers.filter(Boolean).length;
  useEffect(() => { onProgress?.(answeredCount); }, [answeredCount, onProgress]);
  useEffect(() => {
    if (!focusRequest) return;
    headingRef.current?.focus({ preventScroll: true });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [focusRequest]);

  const question = questions[index];
  if (!question) return null;
  const answer = answers[index] ?? null;
  const effectiveAnswers = () => answers.map((current, questionIndex) => customOpen[questionIndex]
    ? drafts[questionIndex]?.trim() ? { questionIndex, question: questions[questionIndex]!.question, kind: "custom" as const, answer: drafts[questionIndex]!.trim() } : current
    : current);
  const commitCustom = () => {
    const next = effectiveAnswers();
    setAnswers(next);
    if (customOpen[index] && next[index]) setCustomOpen((previous) => replaceAt(previous, index, false));
    return next;
  };
  const goTo = (next: number) => {
    commitCustom();
    setError(null);
    setFocusRequest((previous) => previous + 1);
    setReview(false);
    setIndex(next);
  };
  const choose = (optionIndex: number) => {
    if (submittingRef.current) return;
    const option = question.options[optionIndex]!;
    const selected = answer?.kind === "multi" ? answer.selected ?? [] : [];
    const next: QuestionnaireAnswer = question.multiSelect
      ? { questionIndex: index, question: question.question, kind: "multi", answer: null, selected: selected.includes(option.label) ? selected.filter((label) => label !== option.label) : [...selected, option.label] }
      : { questionIndex: index, question: question.question, kind: "option", answer: option.label, ...(option.preview ? { preview: option.preview } : {}) };
    setAnswers((previous) => replaceAt(previous, index, next));
    setCustomOpen((previous) => replaceAt(previous, index, false));
    setError(null);
  };
  const respond = async (response: InteractionResponse) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try { await onRespond(response); }
    catch (cause) {
      submittingRef.current = false;
      setSubmitting(false);
      setError(cause instanceof Error && cause.message ? cause.message : t("interaction.responseFailed"));
    }
  };
  const submit = () => {
    if (submittingRef.current) return;
    const next = commitCustom();
    const missing = next.findIndex((value) => !value);
    if (missing >= 0) {
      setFocusRequest((previous) => previous + 1);
      setReview(false);
      setIndex(missing);
      setError(t("questionnaire.answerRequired", { number: missing + 1 }));
      return;
    }
    void respond({ value: JSON.stringify({ cancelled: false, answers: next.map((value, questionIndex) => ({ ...value!, notes: notes[questionIndex]?.trim() || undefined })) }) });
  };
  const toggleCustom = () => {
    if (!customOpen[index] && answer?.kind === "custom") setDrafts((previous) => replaceAt(previous, index, answer.answer ?? ""));
    setCustomOpen((previous) => replaceAt(previous, index, !previous[index]));
  };
  const selectedRadioIndex = !customOpen[index] && answer?.kind === "option" ? question.options.findIndex((option) => option.label === answer.answer) : -1;
  const radioEntryIndex = Math.max(0, selectedRadioIndex);
  const focusOption = (from: number, key: string) => {
    if (submittingRef.current) return;
    const total = question.options.length + (question.multiSelect ? 1 : 0);
    if (!total) return;
    const next = key === "Home" ? 0 : key === "End" ? total - 1 : (from + (key === "ArrowDown" || key === "ArrowRight" ? 1 : -1) + total) % total;
    if (!question.multiSelect) choose(next);
    optionRefs.current[next]?.focus();
  };

  const isOptionSelected = (optionIndex: number) => {
    const option = question.options[optionIndex]!;
    return Boolean(!customOpen[index] && (question.multiSelect ? answer?.kind === "multi" && answer.selected?.includes(option.label) : answer?.kind === "option" && answer.answer === option.label));
  };
  const optionButton = (optionIndex: number) => {
    const option = question.options[optionIndex]!;
    const selected = isOptionSelected(optionIndex);
    return <button key={`${index}-${optionIndex}`} ref={(node) => { optionRefs.current[optionIndex] = node; }} type="button" role={question.multiSelect ? "checkbox" : "radio"} tabIndex={question.multiSelect || optionIndex === radioEntryIndex ? 0 : -1} aria-checked={selected} onClick={() => choose(optionIndex)} onKeyDown={(event) => {
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); focusOption(optionIndex, event.key); }
    }} className={cn("flex min-h-9 min-w-0 items-start gap-3 px-3 py-2 text-left text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent", question.multiSelect ? "flex-1 rounded-input" : "w-full rounded-l-input", !question.multiSelect && (selected ? "bg-surface-selected" : "hover:bg-surface-2"))}>
      <span className="w-4 shrink-0 text-muted" aria-hidden="true">{selected ? <Check size={14} className="mt-0.5 text-accent" /> : `${optionIndex + 1}.`}</span><span className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{option.label}</span>
    </button>;
  };
  const optionGridRow = `1 / span ${Math.max(1, question.options.length)}`;

  return (
    <section data-request-id={interaction.requestId} aria-label={t("questionnaire.title")} className="flex max-h-[min(360px,60dvh)] min-h-0 flex-col overflow-hidden rounded-composer border border-border bg-surface sm:max-h-[min(320px,50dvh)]" onKeyDown={(event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    }}>
      <header className="flex shrink-0 items-start gap-3 px-4 pb-2 pt-3">
        <h3 id={`${id}-heading`} ref={headingRef} tabIndex={-1} className="max-h-20 min-w-0 flex-1 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-sm font-medium text-text outline-none">{review ? t("questionnaire.review") : question.question}</h3>
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted" aria-label={t("questionnaire.position", { current: index + 1, total: questions.length })}>{index + 1} / {questions.length}</span>
        {onCollapse && <button type="button" onClick={onCollapse} aria-label={t("interaction.collapse")} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2"><ChevronDown size={15} /></button>}
        <span className="sr-only" role="status">{t("questionnaire.progress", { answered: answeredCount, total: questions.length })}</span>
      </header>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3">
        <fieldset disabled={submitting} className="m-0 min-w-0 border-0 p-0 pb-1">
          {review ? (
            <div className="space-y-1" aria-label={t("questionnaire.review")}>
              {questions.map((item, questionIndex) => <button key={questionIndex} type="button" onClick={() => goTo(questionIndex)} className="flex w-full items-start gap-3 rounded-input px-3 py-2 text-left text-sm hover:bg-surface-2">
                <span className="text-muted">{questionIndex + 1}.</span><span className="min-w-0 flex-1 break-words"><span className="block text-text">{item.question}</span><span className="text-xs text-muted">{answers[questionIndex] ? answerLabel(answers[questionIndex]!, t("questionnaire.none")) : t("questionnaire.unanswered")}</span></span>{answers[questionIndex] && <Check size={14} className="shrink-0 text-ok-text" />}
              </button>)}
            </div>
          ) : (
            <>
              {question.multiSelect && <p className="px-3 pb-1 text-xs text-muted">{t("questionnaire.multiSelect")}</p>}
              {question.multiSelect ? (
                <div role="group" aria-labelledby={`${id}-heading`}>
                  {question.options.map((option, optionIndex) => <div key={`${index}-${optionIndex}`} className={cn("flex min-w-0 items-center rounded-input", isOptionSelected(optionIndex) ? "bg-surface-selected" : "hover:bg-surface-2")}>
                    {optionButton(optionIndex)}
                    <QuestionnaireOptionDetails option={option} active={active} disabled={submitting} />
                  </div>)}
                </div>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_2rem]" style={{ gridTemplateRows: `repeat(${Math.max(1, question.options.length)}, auto)` }}>
                  <div role="radiogroup" aria-labelledby={`${id}-heading`} className="col-start-1 grid min-w-0 [grid-template-rows:subgrid]" style={{ gridRow: optionGridRow }}>
                    {question.options.map((_, optionIndex) => optionButton(optionIndex))}
                  </div>
                  <div className="col-start-2 grid [grid-template-rows:subgrid]" style={{ gridRow: optionGridRow }}>
                    {question.options.map((option, optionIndex) => <div key={`${index}-${optionIndex}`} className={cn("flex items-center justify-center rounded-r-input", isOptionSelected(optionIndex) ? "bg-surface-selected" : "hover:bg-surface-2")}>
                      <QuestionnaireOptionDetails option={option} active={active} disabled={submitting} />
                    </div>)}
                  </div>
                </div>
              )}
              <button ref={(node) => { optionRefs.current[question.options.length] = node; }} type="button" aria-expanded={Boolean(customOpen[index])} aria-controls={`${id}-custom`} onClick={toggleCustom} onKeyDown={(event) => {
                  if (question.multiSelect && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); focusOption(question.options.length, event.key); }
                }} className={cn("flex min-h-9 w-full items-center gap-3 rounded-input px-3 py-2 text-left text-sm hover:bg-surface-2", customOpen[index] || answer?.kind === "custom" ? "bg-surface-selected text-text" : "text-muted")}><PenLine size={14} className="shrink-0" />{t("questionnaire.custom")}</button>
              {customOpen[index] && <div id={`${id}-custom`} className="px-3 pb-2 pt-1">
                <label htmlFor={`${id}-answer`} className="sr-only">{t("questionnaire.customLabel")}</label>
                <textarea id={`${id}-answer`} autoFocus rows={2} value={drafts[index] ?? ""} onChange={(event) => setDrafts((previous) => replaceAt(previous, index, event.target.value))} placeholder={t("questionnaire.customPlaceholder")} className="w-full resize-none rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
                <div className="mt-1 flex justify-end gap-2">
                  <button type="button" onClick={() => { setDrafts((previous) => replaceAt(previous, index, "")); setCustomOpen((previous) => replaceAt(previous, index, false)); }} className="rounded-input px-2 py-1 text-xs text-muted hover:bg-surface-2">{t("common.cancel")}</button>
                  <button type="button" disabled={!drafts[index]?.trim()} onClick={() => { commitCustom(); setError(null); }} className="rounded-input px-2 py-1 text-xs text-accent hover:bg-surface-2">{t("questionnaire.saveAnswer")}</button>
                </div>
              </div>}
              {question.multiSelect && <button type="button" onClick={() => { setAnswers((previous) => replaceAt(previous, index, { questionIndex: index, question: question.question, kind: "multi", answer: null, selected: [] })); setCustomOpen((previous) => replaceAt(previous, index, false)); setError(null); }} className="px-3 py-1 text-xs text-muted underline underline-offset-2">{t("questionnaire.none")}</button>}
              {notesOpen[index] && <div className="px-3 py-2">
                <label htmlFor={`${id}-notes`} className="sr-only">{t("questionnaire.notes")}</label>
                <textarea id={`${id}-notes`} autoFocus rows={2} value={notes[index] ?? ""} onChange={(event) => setNotes((previous) => replaceAt(previous, index, event.target.value))} placeholder={t("questionnaire.notesPlaceholder")} className="w-full resize-none rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </div>}
            </>
          )}
        </fieldset>
      </div>
      <footer className="shrink-0 bg-surface px-4 pb-3 pt-2">
        {error && <p role="alert" className="mb-2 text-xs text-error-text">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {!review && <button type="button" disabled={submitting} aria-expanded={Boolean(notesOpen[index])} aria-label={t("questionnaire.notes")} onClick={() => setNotesOpen((previous) => replaceAt(previous, index, !previous[index]))} className="flex items-center gap-1 rounded-input px-1 py-1 text-xs text-muted hover:text-text"><MessageSquareText size={13} />{t(notes[index]?.trim() ? "questionnaire.editNotes" : "questionnaire.addNotes")}</button>}
            {questions.length > 1 && <button type="button" disabled={submitting} aria-label={t(review ? "questionnaire.hideReview" : "questionnaire.review")} aria-expanded={review} onClick={() => { commitCustom(); setFocusRequest((previous) => previous + 1); setReview(!review); }} className="flex items-center gap-1 rounded-input px-1 py-1 text-xs text-muted hover:text-text"><ListChecks size={13} />{t(review ? "questionnaire.hideReview" : "questionnaire.review")}</button>}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={submitting} onClick={() => void respond({ cancelled: true })} className="rounded-input px-1 py-1 text-xs text-muted hover:text-text">{t("questionnaire.cancel")}</button>
            {index > 0 && !review && <button type="button" disabled={submitting} onClick={() => goTo(index - 1)} className="flex items-center gap-1 rounded-input px-1 py-1 text-xs text-muted hover:text-text"><ChevronLeft size={13} />{t("common.back")}</button>}
            {index < questions.length - 1 && !review ? <button type="button" disabled={submitting} onClick={() => goTo(index + 1)} className="flex items-center gap-1 rounded-full bg-accent-fill px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50">{t("common.next")}<ChevronRight size={13} /></button> : <button type="button" disabled={submitting} onClick={submit} className="inline-flex items-center gap-1.5 rounded-full bg-accent-fill px-3 py-1.5 text-xs text-accent-fg disabled:opacity-50" title={t("questionnaire.submitShortcut")}>{submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}{t(submitting ? "questionnaire.submitting" : "questionnaire.submit")}</button>}
          </div>
        </div>
      </footer>
    </section>
  );
}
