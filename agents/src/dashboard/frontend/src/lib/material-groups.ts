import type { ContentSource } from './materials';

export interface MaterialGroup {
  id: string;
  title: string;
  course: boolean;
  sources: ContentSource[];
}

// Recognize the numbered Pimsleur audio import convention, not arbitrary
// similar titles. PDFs remain separate; no backend identity or SRS changes.
export function groupMaterials(sources: ContentSource[]): MaterialGroup[] {
  const groups = new Map<string, MaterialGroup>();
  const order = new Map<string, number>();
  for (const source of sources) {
    const match = source.kind === 'audio'
      ? /^(Pimsleur .+?) - Unit (\d+)(?: \(ASR transcript\))?$/.exec(source.title)
      : null;
    const id = match ? JSON.stringify(['course', source.language, match[1]]) : `source:${source.id}`;
    const group = groups.get(id) ?? { id, title: match?.[1] ?? source.title, course: !!match, sources: [] };
    group.sources.push(source);
    groups.set(id, group);
    if (match) order.set(source.id, Number(match[2]));
  }
  for (const group of groups.values()) {
    if (group.course) group.sources.sort((a, b) => order.get(a.id)! - order.get(b.id)! || a.id.localeCompare(b.id));
  }
  return [...groups.values()];
}
