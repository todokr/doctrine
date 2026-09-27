import type { ReactNode } from "react";

function inline(s: string): ReactNode[] {
  return s.split(/`([^`]+)`/g).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

type Align = "left" | "center" | "right" | undefined;

/** 表の 1 行をセルの文字列に分ける */
function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** 区切り行ならセルごとの寄せを返し、区切り行でなければ null */
function delimiter(line: string | undefined): Align[] | null {
  if (line === undefined || !line.includes("|")) return null;
  const cs = cells(line);
  if (!cs.every((c) => /^:?-+:?$/.test(c))) return null;
  return cs.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : undefined;
  });
}

/** review.files の .md を描く。見出し・箇条書き・表・段落・インラインコードだけを扱う */
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
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    const aligns = line.includes("|") ? delimiter(lines[i + 1]) : null;
    if (aligns) {
      close();
      const head = cells(line);
      const width = head.length;
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const row = cells(lines[i]).slice(0, width);
        while (row.length < width) row.push("");
        rows.push(row);
        i++;
      }
      i--;
      const style = (col: number) => (aligns[col] ? { textAlign: aligns[col] } : undefined);
      blocks.push(
        <div key={blocks.length} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, col) => (
                  <th key={col} style={style(col)}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            {rows.length > 0 && (
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, col) => (
                      <td key={col} style={style(col)}>{inline(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>,
      );
    } else if ((m = line.match(/^(#{1,2}) (.*)/))) {
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
