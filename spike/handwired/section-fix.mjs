// readFrame with section() fixed: test the tag before looking for a heading,
// and look only at direct children, which is what ":scope>" asks for. Same
// result; querySelector walks the whole subtree of each ancestor.
import { readFrame } from "../../node_modules/foxpaw/dist/page/snapshot.js";

const OLD = /const section = \(e\) => \{[\s\S]*?\n    \};\n/;
const NEW = `const section = (e) => {
        for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
            const kind = /^(FORM|FIELDSET|SECTION|DIALOG|NAV|ASIDE|MAIN)$/.test(p.tagName) || p.getAttribute("role") === "dialog";
            if (!kind)
                continue;
            const named = p.getAttribute("aria-label") ||
                [...p.children].find((c) => /^(H1|H2|H3|LEGEND)$/.test(c.tagName))?.textContent?.trim() || "";
            if (named)
                return named.slice(0, 70);
        }
        return "";
    };
`;
const source = readFrame.toString();
if (!OLD.test(source)) throw new Error("section() not found in readFrame");
export const fixedSource = source.replace(OLD, NEW);
export const oldSource = source;
