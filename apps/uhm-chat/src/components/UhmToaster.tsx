import { useEffect, useRef, type PointerEvent } from 'react';
import { toast, Toaster, useSonner, type ToastT } from 'sonner';

function isSecureSessionProcessingToast(notice: ToastT) {
  if (notice.type !== 'loading') return false;
  const id = String(notice.id);
  return id.startsWith('group-info-repair:') || id.startsWith('mls-generation-recovery:') ||
    (typeof notice.title === 'string' && /secure (?:session|messaging)|(?:phiên|nhắn tin) bảo mật/i.test(notice.title));
}

type Swipe = {
  id: ToastT['id'];
  element: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
  previousTranslate: string;
};

export function UhmToaster() {
  const { toasts } = useSonner();
  const swipe = useRef<Swipe | null>(null);

  useEffect(() => {
    for (const notice of toasts) {
      if (!isSecureSessionProcessingToast(notice)) continue;
      const testId = notice.testId ?? `uhm-secure-session-toast:${notice.id}`;
      if (notice.testId === testId && notice.dismissible === true) continue;
      // Bind the gesture to a public Sonner marker without changing loading,
      // promise or duration: completion keeps its native notification lifecycle.
      toast.loading(notice.title, { ...notice, testId, dismissible: true });
    }
  }, [toasts]);

  const resetSwipe = () => {
    if (swipe.current) swipe.current.element.style.translate = swipe.current.previousTranslate;
    swipe.current = null;
  };

  const beginSwipe = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    const element = event.target.closest<HTMLElement>('[data-sonner-toast]');
    if (!element) return;
    const matches = toasts.filter((notice) => isSecureSessionProcessingToast(notice) &&
      notice.testId !== undefined && notice.testId === element.dataset.testid);
    if (matches.length !== 1) return;
    resetSwipe();
    swipe.current = {
      id: matches[0].id, element, pointerId: event.pointerId,
      x: event.clientX, y: event.clientY, startedAt: performance.now(),
      previousTranslate: element.style.translate,
    };
    element.setPointerCapture(event.pointerId);
  };

  const moveSwipe = (event: PointerEvent<HTMLDivElement>) => {
    const current = swipe.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.element.style.translate = `${event.clientX - current.x}px ${event.clientY - current.y}px`;
  };

  const finishSwipe = (event: PointerEvent<HTMLDivElement>) => {
    const current = swipe.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const distance = Math.max(Math.abs(event.clientX - current.x), Math.abs(event.clientY - current.y));
    const elapsed = Math.max(1, performance.now() - current.startedAt);
    if (distance < 45 && (distance < 8 || distance / elapsed <= 0.11)) {
      resetSwipe();
      return;
    }
    swipe.current = null;
    event.preventDefault();
    // Let pointerup reach Sonner so it clears its timer pause after interaction.
    // Sonner invokes onDismiss when it processes this dismissal.
    toast.dismiss(current.id);
  };

  return (
    <div className="contents" onPointerDownCapture={beginSwipe} onPointerMoveCapture={moveSwipe}
      onPointerUpCapture={finishSwipe} onPointerCancelCapture={resetSwipe} onLostPointerCapture={resetSwipe}>
      <Toaster richColors closeButton position="top-right" duration={3000}
        swipeDirections={['left', 'right', 'top', 'bottom']} />
    </div>
  );
}
