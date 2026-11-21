/** A player-list row: name on the left, small tags on the right. Falsy tags are skipped. */
export function PlayerRow({ name, tags, className }: { name: string; tags: Array<string | false>; className?: string }) {
  return (
    <li className={className || undefined}>
      <span>{name}</span>
      <span className="tags">{tags.filter(Boolean).join(' · ')}</span>
    </li>
  );
}
