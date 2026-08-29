"""Dependency-free metric parity layer for AgentSociety choice Replay rows."""

from __future__ import annotations

from collections import defaultdict
import math
from typing import Any, Iterable, Mapping


Choice = tuple[int, str, str]


def choices_from_events(events: Iterable[Mapping[str, Any]]) -> list[Choice]:
    return [
        (int(event["day"]), str(event["chooserId"]), str(event["chosenId"]))
        for event in events
        if event.get("eventType") == "partner_choice"
    ]


def average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def daily_matrix(choices: Iterable[Choice], agent_ids: list[str]) -> dict[int, dict[tuple[int, int], int]]:
    index = {agent_id: position for position, agent_id in enumerate(agent_ids)}
    by_day: dict[int, dict[tuple[int, int], int]] = {}
    for day, sender, receiver in choices:
        if sender not in index or receiver not in index:
            continue
        matrix = by_day.setdefault(day, {})
        pair = (index[sender], index[receiver])
        matrix[pair] = matrix.get(pair, 0) + 1
    return by_day


def repeat_rate(by_day: Mapping[int, Mapping[tuple[int, int], int]]) -> list[float]:
    days = sorted(by_day)
    output: list[float] = []
    for previous_day, current_day in zip(days, days[1:]):
        if current_day != previous_day + 1:
            continue
        previous = set(by_day[previous_day])
        current = set(by_day[current_day])
        if previous:
            output.append(len(previous & current) / len(previous))
    return output


def reciprocity(choices: Iterable[Choice]) -> list[float]:
    grouped: dict[int, list[Choice]] = defaultdict(list)
    for choice in choices:
        grouped[choice[0]].append(choice)
    days = sorted(grouped)
    output: list[float] = []
    for previous_day, current_day in zip(days, days[1:]):
        if current_day != previous_day + 1:
            continue
        previous = grouped[previous_day]
        current = grouped[current_day]
        sender_count = len({sender for _, sender, _ in current})
        if sender_count < 2 or not previous:
            continue
        current_pairs = {(sender, receiver) for _, sender, receiver in current}
        reciprocal_count = sum((receiver, sender) in current_pairs for _, sender, receiver in previous)
        observed_rate = reciprocal_count / len(previous)
        output.append(observed_rate / (1 / (sender_count - 1)))
    return output


def clustering(by_day: Mapping[int, Mapping[tuple[int, int], int]], n: int) -> list[float]:
    output: list[float] = []
    for matrix in by_day.values():
        adjacency = [set() for _ in range(max(0, n))]
        for sender, receiver in matrix:
            adjacency[sender].add(receiver)
            adjacency[receiver].add(sender)
        triangles = 0
        triples = 0
        for neighbors in adjacency:
            ordered = list(neighbors)
            triples += len(ordered) * (len(ordered) - 1) // 2
            for left in range(len(ordered)):
                for right in range(left + 1, len(ordered)):
                    if ordered[right] in adjacency[ordered[left]]:
                        triangles += 1
        output.append(triangles / triples if triples else 0.0)
    return output


def diversity(
    by_day: Mapping[int, Mapping[tuple[int, int], int]], n: int, window: int = 7
) -> list[float]:
    days = sorted(by_day)
    output: list[float] = []
    for day_index in range(len(days)):
        partners = [set() for _ in range(max(0, n))]
        for selected_index in range(max(0, day_index - window + 1), day_index + 1):
            for sender, receiver in by_day[days[selected_index]]:
                partners[sender].add(receiver)
        active_counts = [float(len(items)) for items in partners if items]
        output.append(average(active_counts))
    return output


def partner_hhi(
    by_day: Mapping[int, Mapping[tuple[int, int], int]], n: int, window: int = 7
) -> list[float]:
    days = sorted(by_day)
    width = max(1, int(window))
    output: list[float] = []
    for day_index, day in enumerate(days):
        outgoing = [defaultdict(int) for _ in range(max(0, n))]
        first_day = day - width + 1
        for selected_day in days[: day_index + 1]:
            if selected_day < first_day:
                continue
            for (sender, receiver), count in by_day[selected_day].items():
                if 0 <= sender < n and 0 <= receiver < n and count > 0:
                    outgoing[sender][receiver] += count
        values: list[float] = []
        for partners in outgoing:
            total = sum(partners.values())
            if total:
                values.append(sum((count / total) ** 2 for count in partners.values()))
        output.append(max(0.0, min(1.0, average(values))))
    return output


def directed_vector(matrix: Mapping[tuple[int, int], int], n: int) -> list[float]:
    return [
        float(max(0, matrix.get((sender, receiver), 0)))
        for sender in range(max(0, n))
        for receiver in range(max(0, n))
        if sender != receiver
    ]


def matrix_persistence(
    by_day: Mapping[int, Mapping[tuple[int, int], int]], n: int, window: int = 7
) -> list[float]:
    days = sorted(by_day)
    output: list[float] = []
    width = max(1, int(window))

    def aggregate(selected_days: list[int]) -> dict[tuple[int, int], int]:
        result: dict[tuple[int, int], int] = {}
        for day in selected_days:
            for pair, count in by_day[day].items():
                result[pair] = result.get(pair, 0) + count
        return result

    for end in range(width * 2 - 1, len(days)):
        segment = days[end - width * 2 + 1 : end + 1]
        if any(day != segment[index - 1] + 1 for index, day in enumerate(segment) if index > 0):
            continue
        previous = directed_vector(aggregate(segment[:width]), n)
        current = directed_vector(aggregate(segment[width:]), n)
        if not previous:
            output.append(0.0)
            continue
        previous_mean = average(previous)
        current_mean = average(current)
        covariance = sum(
            (left - previous_mean) * (right - current_mean)
            for left, right in zip(previous, current)
        )
        previous_variance = sum((value - previous_mean) ** 2 for value in previous)
        current_variance = sum((value - current_mean) ** 2 for value in current)
        if previous_variance == 0 or current_variance == 0:
            output.append(1.0 if any(value > 0 for value in previous) and previous == current else 0.0)
            continue
        output.append(
            max(-1.0, min(1.0, covariance / math.sqrt(previous_variance * current_variance)))
        )
    return output


def hub_concentration(
    by_day: Mapping[int, Mapping[tuple[int, int], int]], n: int
) -> list[float]:
    output: list[float] = []
    for day in sorted(by_day):
        if n < 2:
            output.append(0.0)
            continue
        incoming = [0 for _ in range(n)]
        for (sender, receiver), count in by_day[day].items():
            if 0 <= sender < n and 0 <= receiver < n and count > 0:
                incoming[receiver] += count
        total = sum(incoming)
        if total == 0:
            output.append(0.0)
            continue
        maximum = max(incoming)
        numerator = sum(maximum - strength for strength in incoming)
        output.append(max(0.0, min(1.0, numerator / ((n - 1) * total))))
    return output


def metrics_of(choices: list[Choice], agent_ids: list[str]) -> dict[str, Any]:
    by_day = daily_matrix(choices, agent_ids)
    pairs: dict[str, int] = defaultdict(int)
    for matrix in by_day.values():
        for (sender, receiver), count in matrix.items():
            pairs[f"{sender}:{receiver}"] += count
    return {
        "repeat": repeat_rate(by_day),
        "recip": reciprocity(choices),
        "clus": clustering(by_day, len(agent_ids)),
        "div": diversity(by_day, len(agent_ids)),
        "hhi": partner_hhi(by_day, len(agent_ids)),
        "persistence": matrix_persistence(by_day, len(agent_ids)),
        "hub": hub_concentration(by_day, len(agent_ids)),
        "pairs": dict(pairs),
    }
