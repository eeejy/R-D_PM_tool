"use client";

import { useState } from "react";
import QuickAdd from "./QuickAdd";
import TaskRow from "./TaskRow";
import { score, type MyTask } from "@/lib/mytask";
import { CATEGORIES } from "@/lib/worktree";

/**
 * 업무트리 — 연구기관의 WBS가 아니라 **내 업무체계**다.
 *
 * 카테고리는 고정이고, 각 카테고리에는 (a) 담당자가 늘 챙기는 기본 업무 목록과
 * (b) 실제로 등록한 업무가 함께 붙는다. 기본 목록은 체크리스트 역할을 하고,
 * 등록된 업무만 개요의 오늘/이번 주에 올라간다.
 */
export default function WorkTreeView({
  today,
  tasks,
  onAdd,
  onDone,
  onDefer,
  onMove,
  onRemove,
}: {
  today: string;
  tasks: MyTask[];
  onAdd: (tasks: MyTask[]) => void;
  onDone: (id: string) => void;
  onDefer: (id: string) => void;
  onMove: (id: string, categoryId: MyTask["categoryId"]) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState<string[]>(["data", "meeting"]);
  const [showDone, setShowDone] = useState(false);

  const toggle = (id: string) =>
    setOpen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const active = tasks.filter((task) => showDone || task.status !== "완료");

  return (
    <div className="view">
      <div className="view__head">
        <h1 className="view__title">업무트리</h1>
        <p className="view__sub">사업담당자가 수행하는 업무를 8개 영역으로 나눠 관리합니다 · 등록 {tasks.filter((t) => t.status !== "완료").length}건</p>
      </div>

      <QuickAdd today={today} onAdd={onAdd} />

      <div className="tree-actions">
        <label className="cosmetic-toggle">
          <input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />
          완료한 업무도 보기
        </label>
        <button className="btn btn--sm btn--ghost" onClick={() => setOpen(CATEGORIES.map((category) => category.id))}>모두 펼치기</button>
        <button className="btn btn--sm btn--ghost" onClick={() => setOpen([])}>모두 접기</button>
      </div>

      <div className="tree">
        {CATEGORIES.map((category) => {
          const mine = active
            .filter((task) => task.categoryId === category.id)
            .map((task) => score(task, today))
            .sort((a, b) => b.score - a.score);
          const isOpen = open.includes(category.id);
          const urgent = mine.filter((task) => task.urgency === "긴급").length;

          return (
            <section key={category.id} className="tree__cat">
              <button className="tree__head" onClick={() => toggle(category.id)} aria-expanded={isOpen}>
                <span className="tree__mark">{category.mark}</span>
                <span className="tree__name">{category.title}</span>
                {urgent > 0 && <span className="tag tag--danger">긴급 {urgent}</span>}
                <span className="tree__count">{mine.length}</span>
                <span className="tree__chev">{isOpen ? "−" : "+"}</span>
              </button>

              {isOpen && (
                <div className="tree__body">
                  {mine.length > 0 && (
                    <div className="bucket__list">
                      {mine.map((task) => (
                        <div key={task.id} className="tree__task">
                          <TaskRow task={task} onDone={onDone} onDefer={onDefer} showCategory={false} />
                          <div className="tree__task-actions">
                            <select
                              className="select select--sm"
                              value={task.categoryId}
                              onChange={(event) => onMove(task.id, event.target.value as MyTask["categoryId"])}
                              aria-label="분류 변경"
                            >
                              {CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                            </select>
                            <button className="btn btn--sm btn--ghost" onClick={() => onRemove(task.id)}>삭제</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="tree__standard">
                    <p className="tree__standard-label">상시 점검 항목</p>
                    <ul>
                      {category.items.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
