"use client"

import { cn } from "@/seq/lib/utils"

import type React from "react"
import { memo } from "react"
import { SettingsIcon, GridIcon, PlusIcon, TransitionIcon, InfoIcon, StoryboardIcon, LogoIcon } from "./icons"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/seq/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/seq/components/ui/tooltip"
import { UserMenu } from "./user-menu"
import { Layers } from "lucide-react"

export type SidebarView = "library" | "create" | "settings" | "transitions" | "inspector" | "storyboard" | "zentrix"

export interface EditorSidebarProps {
  activeView: SidebarView
  isPanelOpen: boolean
  onViewChange: (view: SidebarView) => void
  onTogglePanel: () => void
  onBack: () => void
}

const ZentrixIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
    <polyline points="7.5 19.79 7.5 14.6 3 12" />
    <polyline points="21 12 16.5 14.6 16.5 19.79" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
)

const SIDEBAR_ITEMS: {
  id: SidebarView
  icon: React.FC<{ className?: string }>
  label: string
  miniLabel: string
  shortcut?: string
}[] = [
  { id: "zentrix", icon: ZentrixIcon, label: "Zentrix", miniLabel: "Zentrix", shortcut: "Z" },
  { id: "create", icon: PlusIcon, label: "Crear", miniLabel: "Crear", shortcut: "1" },
  { id: "library", icon: GridIcon, label: "Biblioteca", miniLabel: "Biblioteca", shortcut: "2" },
  { id: "storyboard", icon: StoryboardIcon, label: "Storyboard", miniLabel: "Paneles", shortcut: "3" },
  { id: "transitions", icon: TransitionIcon, label: "Transiciones", miniLabel: "Efectos", shortcut: "4" },
  { id: "inspector", icon: InfoIcon, label: "Inspector", miniLabel: "Detalles", shortcut: "5" },
  { id: "settings", icon: SettingsIcon, label: "Configuración", miniLabel: "Config", shortcut: "6" },
]

function EditorSidebarInner({ activeView, isPanelOpen, onViewChange, onTogglePanel, onBack }: EditorSidebarProps) {
  const { state, toggleSidebar } = useSidebar()
  const isCollapsed = state === "collapsed"

  return (
    <Sidebar collapsible="icon" className="border-r border-[var(--border-default)]">
      <SidebarHeader
        className={cn(
          "flex h-[88px] flex-row justify-start p-4 pt-8 ",
          isCollapsed && "relative inline-block h-auto w-full max-w-28 p-2 pt-4 pb-0",
        )}
      >
        <a className="relative inline-block h-auto w-full max-w-28 p-2 " href="/">
          <span
            className={cn(
              " flex items-center justify-center drop-shadow-logo [&_path]:transition-[d] [&_path]:duration-[3s] h-full w-full object-contain drop-shadow-logo md:drop-shadow-none ",
            )}
          >
            <LogoIcon className="h-7 w-7 flex-shrink-0" />
          </span>
        </a>
      </SidebarHeader>

      <SidebarContent className="px-0">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <div className="mb-2 flex justify-center">
              <UserMenu />
            </div>

            <SidebarMenu className="flex flex-col gap-[10px]">
              {SIDEBAR_ITEMS.map(({ id, icon: Icon, label, miniLabel, shortcut }) => {
                const isActive = activeView === id && isPanelOpen
                return (
                  <SidebarMenuItem key={id} className={cn("p-0")}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SidebarMenuButton
                          onClick={() => {
                            if (activeView === id) {
                              onTogglePanel()
                            } else {
                              onViewChange(id)
                            }
                          }}
                          isActive={isActive}
                          className={cn(
                            !isCollapsed && "h-10 gap-3 rounded-md px-3 transition-colors items-center flex",

                            isCollapsed &&
                              "data-[active=true]:bg-transparent active:bg-transparent focus:bg-transparent hover:bg-transparent h-auto flex flex-col items-center justify-center gap-[2px] text-center text-[11px] leading-[16px] group/sidebar-item font-semibold p-0",
                          )}
                        >
                          <div
                            className={cn(
                              "p-1.5 rounded-md group-hover/sidebar-item:bg-[var(--hover-overlay)] transition-colors",
                              isActive && "bg-[var(--hover-overlay)]",
                              id === "zentrix" && isActive && "bg-indigo-600/20",
                            )}
                          >
                            <Icon
                              className={cn(
                                "h-4 w-4 shrink-0",
                                isActive ? "text-primary" : "text-[var(--text-tertiary)] group-hover/sidebar-item:text-primary/70",
                                id === "zentrix" && isActive && "text-indigo-400",
                              )}
                            />
                          </div>
                          {isCollapsed && (
                            <span className={cn(isActive ? "text-primary" : "text-[var(--text-tertiary)]",
                              id === "zentrix" && isActive && "text-indigo-400",
                            )}>
                              {miniLabel}
                            </span>
                          )}
                          {!isCollapsed && (
                            <span
                              className={cn(
                                "text-sm",
                                isActive ? "text-primary font-medium" : "text-[var(--text-tertiary)]",
                              )}
                            >
                              {label}
                            </span>
                          )}
                        </SidebarMenuButton>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8} hidden={!isCollapsed}>
                        <p>
                          {label}
                          {shortcut && <span className="ml-2 text-[var(--text-muted)]">({shortcut})</span>}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="mt-auto border-t border-[var(--border-default)] p-3">
        <div className="text-center">
          <span className="text-[9px] font-bold text-[var(--text-tertiary)] tracking-wider">ZENTRIX</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}

export const EditorSidebar = memo(function EditorSidebar(props: EditorSidebarProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <EditorSidebarInner {...props} />
    </TooltipProvider>
  )
})

export default EditorSidebar
