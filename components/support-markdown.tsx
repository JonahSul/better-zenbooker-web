import Markdown from 'react-markdown';
export const supportMarkdownElements=['p','em','strong','ul','ol','li','h2','h3','code','pre','br'];
export default function SupportMarkdown({children}:{children:string}){return <Markdown allowedElements={supportMarkdownElements} skipHtml unwrapDisallowed components={{a:({children})=><>{children}</>,img:()=>null}}>{children}</Markdown>;}
