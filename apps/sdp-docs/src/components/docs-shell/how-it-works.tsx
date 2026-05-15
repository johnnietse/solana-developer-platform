"use client";

import React from "react";

export function HowItWorks({ children }: { children: React.ReactNode }) {
  return <div className="hiw-root">{children}</div>;
}

export function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  const left: React.ReactNode[] = [];
  const right: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === StepPanel) {
      right.push(child);
    } else if (typeof child !== "string" || child.trim()) {
      left.push(child);
    }
  });

  return (
    <div className="hiw-step" id={`step-${number}`}>
      <div className="hiw-step-left">
        <div className="hiw-step-header">
          <span className="hiw-step-num" aria-hidden="true">{number}</span>
          <h3 className="hiw-step-title">{title}</h3>
        </div>
        {left.length > 0 && <div className="hiw-step-body">{left}</div>}
      </div>
      <div className="hiw-step-right">{right}</div>
    </div>
  );
}

export function StepPanel({ children }: { children: React.ReactNode }) {
  return <div className="hiw-step-panel">{children}</div>;
}
