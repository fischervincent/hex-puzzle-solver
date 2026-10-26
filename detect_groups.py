import sys
from dataclasses import dataclass, field

import cv2
import numpy as np

MIN_SATURATION = 120
MIN_VALUE = 120
MIN_NODE_CORE_AREA = 20
NODE_CORE_RATIO = 0.6
MAX_NEIGHBOR_DISTANCE_IN_PITCHES = 1.35
BAR_SAMPLE_COUNT = 30
BAR_MATCH_RATIO = 0.75
BAR_SEGMENT_START = 0.3
BAR_SEGMENT_END = 0.7
MAX_HUE_DIFFERENCE = 12


@dataclass
class Node:
    x: float
    y: float
    hue: float
    color_bgr: tuple[int, int, int]


@dataclass
class Group:
    color_bgr: tuple[int, int, int]
    nodes: list[Node] = field(default_factory=list)
    links: list[tuple[int, int]] = field(default_factory=list)


def colored_mask(hsv: np.ndarray) -> np.ndarray:
    saturated = (hsv[:, :, 1] >= MIN_SATURATION) & (hsv[:, :, 2] >= MIN_VALUE)
    return saturated.astype(np.uint8) * 255


def fill_holes(mask: np.ndarray) -> np.ndarray:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)
    return filled


def hue_difference(a: float, b: float) -> float:
    difference = abs(a - b) % 180
    return min(difference, 180 - difference)


def find_nodes(image: np.ndarray, mask: np.ndarray, hsv: np.ndarray) -> tuple[list[Node], float]:
    distance = cv2.distanceTransform(fill_holes(mask), cv2.DIST_L2, 5)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(fill_holes(mask))
    blob_radii = [
        float(distance[labels == i].max())
        for i in range(1, count)
        if stats[i, cv2.CC_STAT_AREA] >= MIN_NODE_CORE_AREA
    ]
    node_radius = float(np.median(blob_radii))

    cores = (distance > node_radius * NODE_CORE_RATIO).astype(np.uint8)
    core_count, core_labels, core_stats, centroids = cv2.connectedComponentsWithStats(cores)
    nodes = []
    for i in range(1, core_count):
        if core_stats[i, cv2.CC_STAT_AREA] < MIN_NODE_CORE_AREA:
            continue
        x, y = float(centroids[i][0]), float(centroids[i][1])
        colored_pixels = disk(mask.shape, x, y, node_radius) & (mask > 0)
        hue = float(np.median(hsv[:, :, 0][colored_pixels]))
        color = np.median(image[colored_pixels], axis=0)
        nodes.append(Node(x, y, hue, (int(color[0]), int(color[1]), int(color[2]))))
    return nodes, node_radius


def disk(shape: tuple[int, ...], x: float, y: float, radius: float) -> np.ndarray:
    rows, columns = np.ogrid[: shape[0], : shape[1]]
    return (columns - x) ** 2 + (rows - y) ** 2 <= radius**2


def is_bar_between(mask: np.ndarray, hsv: np.ndarray, a: Node, b: Node) -> bool:
    if hue_difference(a.hue, b.hue) > MAX_HUE_DIFFERENCE:
        return False
    matches = 0
    for t in np.linspace(BAR_SEGMENT_START, BAR_SEGMENT_END, BAR_SAMPLE_COUNT):
        x = int(round(a.x + (b.x - a.x) * t))
        y = int(round(a.y + (b.y - a.y) * t))
        if mask[y, x] and hue_difference(float(hsv[y, x, 0]), a.hue) <= MAX_HUE_DIFFERENCE:
            matches += 1
    return matches / BAR_SAMPLE_COUNT >= BAR_MATCH_RATIO


def cell_pitch(nodes: list[Node]) -> float:
    nearest_distances = [
        min(np.hypot(a.x - b.x, a.y - b.y) for b in nodes if b is not a)
        for a in nodes
    ]
    return float(np.median(nearest_distances))


def find_links(mask: np.ndarray, hsv: np.ndarray, nodes: list[Node]) -> list[tuple[int, int]]:
    max_distance = cell_pitch(nodes) * MAX_NEIGHBOR_DISTANCE_IN_PITCHES
    links = []
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            distance = np.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)
            if distance <= max_distance and is_bar_between(mask, hsv, nodes[i], nodes[j]):
                links.append((i, j))
    return links


def connected_components(node_count: int, links: list[tuple[int, int]]) -> list[list[int]]:
    parent = list(range(node_count))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in links:
        parent[root(a)] = root(b)

    components: dict[int, list[int]] = {}
    for i in range(node_count):
        components.setdefault(root(i), []).append(i)
    return list(components.values())


def detect_groups(image: np.ndarray) -> tuple[list[Group], float]:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    mask = colored_mask(hsv)
    nodes, node_radius = find_nodes(image, mask, hsv)
    links = find_links(mask, hsv, nodes)

    groups = []
    for member_indices in connected_components(len(nodes), links):
        local_index = {global_index: local for local, global_index in enumerate(member_indices)}
        members = [nodes[i] for i in member_indices]
        groups.append(
            Group(
                color_bgr=members[0].color_bgr,
                nodes=members,
                links=[(local_index[a], local_index[b]) for a, b in links if a in local_index],
            )
        )
    groups.sort(key=lambda group: (min(n.y for n in group.nodes), min(n.x for n in group.nodes)))
    return groups, node_radius


def draw_debug(image: np.ndarray, groups: list[Group]) -> np.ndarray:
    canvas = (image * 0.3).astype(np.uint8)
    for index, group in enumerate(groups):
        for a, b in group.links:
            start = (int(group.nodes[a].x), int(group.nodes[a].y))
            end = (int(group.nodes[b].x), int(group.nodes[b].y))
            cv2.line(canvas, start, end, group.color_bgr, 5)
        for node in group.nodes:
            center = (int(node.x), int(node.y))
            cv2.circle(canvas, center, 14, group.color_bgr, -1)
            cv2.circle(canvas, center, 14, (255, 255, 255), 2)
        top_node = min(group.nodes, key=lambda n: n.y)
        cv2.putText(canvas, f"G{index}", (int(top_node.x) + 18, int(top_node.y) - 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    return canvas


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: python3 detect_groups.py <image> [debug_output.png]")
        sys.exit(1)

    image = cv2.imread(sys.argv[1])
    if image is None:
        print(f"could not read {sys.argv[1]}")
        sys.exit(1)

    groups, node_radius = detect_groups(image)
    print(f"node radius ~{node_radius:.1f}px\n")
    for index, group in enumerate(groups):
        positions = ", ".join(f"({node.x:.0f},{node.y:.0f})" for node in group.nodes)
        print(f"G{index}: {len(group.nodes)} nodes, {len(group.links)} links, bgr={group.color_bgr}")
        print(f"    nodes: {positions}")
        print(f"    links: {group.links}")

    output_path = sys.argv[2] if len(sys.argv) > 2 else "debug_groups.png"
    cv2.imwrite(output_path, draw_debug(image, groups))
    print(f"\n{len(groups)} groups found, debug image written to {output_path}")


if __name__ == "__main__":
    main()
