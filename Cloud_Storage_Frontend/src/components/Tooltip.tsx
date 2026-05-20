// components/Tooltip.tsx
'use client'

import React from 'react'

interface TooltipProps {
    children: React.ReactNode
    text: string
    color?: 'gray' | 'red' | 'blue' | 'green'
    position?: 'top' | 'bottom'
}

export default function Tooltip({ children, text, color = 'gray', position = 'top' }: TooltipProps) {
    const colors = {
        gray: {
            bg: 'bg-gray-900 dark:bg-white',
            text: 'text-white dark:text-black',
            arrow: 'border-t-gray-900 dark:border-t-white',
        },
        red: {
            bg: 'bg-red-600',
            text: 'text-white',
            arrow: 'border-t-red-600',
        },
        blue: {
            bg: 'bg-blue-600',
            text: 'text-white',
            arrow: 'border-t-blue-600',
        },
        green: {
            bg: 'bg-green-600',
            text: 'text-white',
            arrow: 'border-t-green-600',
        },
    }

    const c = colors[color]

    const positionClasses = position === 'top'
        ? 'absolute -top-9 left-1/2 -translate-x-1/2'
        : 'absolute -bottom-9 left-1/2 -translate-x-1/2'

    const arrowClasses = position === 'top'
        ? `absolute top-full left-1/2 -translate-x-1/2 border-[5px] border-transparent ${c.arrow}`
        : `absolute bottom-full left-1/2 -translate-x-1/2 border-[5px] border-transparent border-b-gray-900 dark:border-b-white`

    return (
        <div className="relative group/tip inline-flex">
            {children}
            <div className={`${positionClasses} hidden group-hover/tip:block z-50`}>
                <div className={`${c.bg} ${c.text} text-[10px] font-medium px-2.5 py-1 rounded-md shadow-lg whitespace-nowrap`}>
                    {text}
                    <div className={arrowClasses}></div>
                </div>
            </div>
        </div>
    )
}