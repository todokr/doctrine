import type { ReactNode } from "react";

function inline(s: string): ReactNode[] {
  return s.split(/`([^`]+)`/g).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** review.files の .md を描く。見出し・箇条書き・段落・インラインコードだけを扱う */
export function Markdown({ src }: { src: string }) {
  const blocks: ReactNode[] = [];
  let list: { tag: "ul" | "ol"; items: ReactNode[] } | null = null;
  const close = () => {
    if (!list) return;
    const Tag = list.tag;
    blocks.push(<Tag key={blocks.length}>{list.items}</Tag>);
    list = null;
  };
  const item = (tag: "ul" | "ol", text: string) => {
    if (list?.tag !== tag) {
      close();
      list = { tag, items: [] };
    }
    list!.items.push(<li key={list!.items.length}>{inline(text)}</li>);
  };
  for (const line of src.split("\n")) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,2}) (.*)/))) {
      close();
      const H = m[1].length === 1 ? "h1" : "h2";
      blocks.push(<H key={blocks.length}>{inline(m[2])}</H>);
    } else if ((m = line.match(/^- (.*)/))) item("ul", m[1]);
    else if ((m = line.match(/^\d+\. (.*)/))) item("ol", m[1]);
    else if (line.trim()) {
      close();
      blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  close();
  return <>{blocks}</>;
}
