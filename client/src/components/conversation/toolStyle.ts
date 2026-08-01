import {
  Wrench,
  Terminal,
  FileText,
  FilePlus2,
  FilePen,
  Search,
  Globe,
  Bot,
  ListTodo,
  Clock,
  Sparkles,
  FolderTree,
  type LucideIcon,
} from "lucide-react";

export interface ToolStyle {
  Icon: LucideIcon;
  
  text: string;
  

  chip: string;
  

  bar: string;
  
  border: string;
}

const VIOLET: ToolStyle = {
  Icon: Wrench,
  text: "text-accent-hover",
  chip: "bg-accent/15 text-accent-hover",
  bar: "bg-accent/60",
  border: "border-accent/20",
};

const STYLES: Record<string, ToolStyle> = {
  bash: {
    Icon: Terminal,
    text: "text-status-working/90",
    chip: "bg-status-working/15 text-status-working/90",
    bar: "bg-status-working/60",
    border: "border-status-working/20",
  },
  read: {
    Icon: FileText,
    text: "text-accent",
    chip: "bg-accent/15 text-accent",
    bar: "bg-accent/60",
    border: "border-accent/20",
  },
  write: {
    Icon: FilePlus2,
    text: "text-accent-hover",
    chip: "bg-accent/15 text-accent-hover",
    bar: "bg-accent/60",
    border: "border-accent/20",
  },
  edit: {
    Icon: FilePen,
    text: "text-status-waiting/90",
    chip: "bg-status-waiting/15 text-status-waiting/90",
    bar: "bg-status-waiting/60",
    border: "border-status-waiting/20",
  },
  multiedit: {
    Icon: FilePen,
    text: "text-status-waiting/90",
    chip: "bg-status-waiting/15 text-status-waiting/90",
    bar: "bg-status-waiting/60",
    border: "border-status-waiting/20",
  },
  grep: {
    Icon: Search,
    text: "text-accent",
    chip: "bg-accent/15 text-accent",
    bar: "bg-accent/60",
    border: "border-accent/20",
  },
  glob: {
    Icon: FolderTree,
    text: "text-accent",
    chip: "bg-accent/15 text-accent",
    bar: "bg-accent/60",
    border: "border-accent/20",
  },
  webfetch: {
    Icon: Globe,
    text: "text-accent",
    chip: "bg-accent/15 text-accent",
    bar: "bg-accent/60",
    border: "border-accent/20",
  },
  websearch: {
    Icon: Globe,
    text: "text-accent",
    chip: "bg-accent/15 text-accent",
    bar: "bg-accent/60",
    border: "border-accent/20",
  },
  task: {
    Icon: Bot,
    text: "text-status-working",
    chip: "bg-status-working/15 text-status-working",
    bar: "bg-status-working/60",
    border: "border-status-working/20",
  },
  agent: {
    Icon: Bot,
    text: "text-status-working",
    chip: "bg-status-working/15 text-status-working",
    bar: "bg-status-working/60",
    border: "border-status-working/20",
  },
  todowrite: {
    Icon: ListTodo,
    text: "text-status-waiting",
    chip: "bg-status-waiting/15 text-status-waiting",
    bar: "bg-status-waiting/60",
    border: "border-status-waiting/20",
  },
  schedulewakeup: {
    Icon: Clock,
    text: "text-status-waiting",
    chip: "bg-status-waiting/15 text-status-waiting",
    bar: "bg-status-waiting/60",
    border: "border-status-waiting/20",
  },
  skill: {
    Icon: Sparkles,
    text: "text-accent",
    chip: "bg-accent/15 text-accent",
    bar: "bg-accent/60",
    border: "border-accent/20",
  },
};

export function styleForTool(toolName: string | undefined | null): ToolStyle {
  if (!toolName) return VIOLET;
  const key = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return STYLES[key] ?? VIOLET;
}
