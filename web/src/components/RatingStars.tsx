import { cn } from './ui';

/**
 * A five-star control.
 *
 * Rating is not just a label here — it is what tells the server to copy the
 * image out of ComfyUI and into local storage, so it survives the instance that
 * made it being destroyed. Tapping the current rating again clears it.
 */
export function RatingStars({
  value,
  onChange,
  size = 'md',
}: {
  value: number;
  onChange: (rating: number) => void;
  size?: 'sm' | 'md';
}) {
  const dimension = size === 'sm' ? 'size-7 text-base' : 'size-9 text-xl';

  return (
    <div className="flex items-center" role="group" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          aria-label={`${star} star${star > 1 ? 's' : ''}`}
          aria-pressed={value >= star}
          onClick={() => onChange(value === star ? 0 : star)}
          className={cn(
            'grid place-items-center rounded-lg transition-colors active:bg-white/10',
            dimension,
            value >= star ? 'text-warn' : 'text-muted/40',
          )}
        >
          {value >= star ? '★' : '☆'}
        </button>
      ))}
    </div>
  );
}
