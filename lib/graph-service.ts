import { Buffer } from 'node:buffer';
import { octokit, parseRepoUrl, getRepoHead } from './github';
import { kv } from './kv';
import { getLocks } from './locks';
import { getFileLanguage, parseImports } from './parser';
import { ImportResolver } from './resolver';

export interface GraphNode {
  id: string;
  type: 'file';
  size?: number;
  language?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'import';
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  locks: Record<string, unknown>;
  version: string;
  metadata: {
    generated_at: number;
    files_processed: number;
    edges_found: number;
  };
}

interface RepoFile {
  path: string;
  sha: string;
  size?: number;
}

export class GraphService {
  private repoUrl: string;
  private branch: string;
  private owner: string;
  private repo: string;

  constructor(repoUrl: string, branch = 'main') {
    this.repoUrl = repoUrl;
    this.branch = branch;

    const parsed = parseRepoUrl(repoUrl);
    this.owner = parsed.owner;
    this.repo = parsed.repo;
  }

  private getKeys() {
    return {
      graph: `graph:${this.repoUrl}:${this.branch}`,
      meta: `graph:meta:${this.repoUrl}:${this.branch}`,
      fileShas: `graph:file_shas:${this.repoUrl}:${this.branch}`,
    };
  }

  async getCached(): Promise<DependencyGraph | null> {
    const keys = this.getKeys();
    const cached = (await kv.get(keys.graph)) as string | null;

    if (!cached) {
      return null;
    }

    try {
      const graph = JSON.parse(cached) as DependencyGraph;
      graph.locks = await getLocks(this.repoUrl, this.branch);
      return graph;
    } catch {
      return null;
    }
  }

  async needsUpdate(): Promise<{ needsUpdate: boolean; currentHead: string }> {
    const keys = this.getKeys();
    const currentHead = await getRepoHead(this.owner, this.repo, this.branch);
    const storedHead = (await kv.get(keys.meta)) as string | null;

    return {
      needsUpdate: currentHead !== storedHead,
      currentHead,
    };
  }

  async generate(force = false): Promise<DependencyGraph> {
    const keys = this.getKeys();
    const startTime = Date.now();

    const currentHead = await getRepoHead(this.owner, this.repo, this.branch);

    if (!force) {
      const storedHead = (await kv.get(keys.meta)) as string | null;
      if (storedHead === currentHead) {
        const cached = await this.getCached();
        if (cached) {
          return cached;
        }
      }
    }

    const { data: treeData } = await octokit.rest.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: currentHead,
      recursive: 'true',
    });

    const supportedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py'];
    const files = (treeData.tree ?? [])
      .filter((item) => item.type === 'blob' && typeof item.path === 'string')
      .filter((item) => supportedExtensions.some((ext) => item.path!.endsWith(ext)))
      .map((item) => ({
        path: item.path as string,
        sha: item.sha as string,
        size: item.size ?? undefined,
      })) as RepoFile[];

    const storedShas = ((await kv.hgetall(keys.fileShas)) as Record<string, string> | null) ?? {};
    const allFilePaths = new Set(files.map((file) => file.path));

    const newFiles = files.filter((file) => !storedShas[file.path]);
    const changedFiles = files.filter((file) => storedShas[file.path] && storedShas[file.path] !== file.sha);
    const deletedFiles = Object.keys(storedShas).filter((filePath) => !allFilePaths.has(filePath));

    let nodes: GraphNode[] = [];
    let edges: GraphEdge[] = [];
    let hasExistingGraph = false;

    const existing = (await kv.get(keys.graph)) as string | null;
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as DependencyGraph;
        nodes = parsed.nodes;
        edges = parsed.edges;
        hasExistingGraph = true;
      } catch {
        nodes = [];
        edges = [];
      }

      if (deletedFiles.length > 0) {
        nodes = nodes.filter((node) => !deletedFiles.includes(node.id));
        edges = edges.filter((edge) => !deletedFiles.includes(edge.source) && !deletedFiles.includes(edge.target));
      }

      if (changedFiles.length > 0) {
        const changedSet = new Set(changedFiles.map((file) => file.path));
        edges = edges.filter((edge) => !changedSet.has(edge.source));
      }
    }

    // If graph payload is missing/corrupt but file SHAs still exist, incremental mode can end up empty forever.
    // In that case, force a full rebuild from the current tree.
    const incrementalFiles = [...newFiles, ...changedFiles];
    const needsFullRebuild =
      !hasExistingGraph ||
      (files.length > 0 && nodes.length === 0 && incrementalFiles.length === 0);

    if (needsFullRebuild) {
      console.log('[Graph] Full rebuild triggered');
      nodes = [];
      edges = [];
    }

    const resolver = new ImportResolver(allFilePaths);
    const filesToProcess = needsFullRebuild ? files : incrementalFiles;
    let processedCount = 0;
    const edgeSet = new Set(edges.map((edge) => `${edge.source}=>${edge.target}`));

    for (const file of filesToProcess) {
      const filePath = file.path;

      if (!nodes.some((node) => node.id === filePath)) {
        nodes.push({
          id: filePath,
          type: 'file',
          size: file.size,
          language: getFileLanguage(filePath) ?? undefined,
        });
      }

      try {
        const { data: contentData } = await octokit.rest.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path: filePath,
          ref: currentHead,
        });

        if (!('content' in contentData) || typeof contentData.content !== 'string') {
          continue;
        }

        const content = Buffer.from(contentData.content, 'base64').toString('utf-8');
        const language = getFileLanguage(filePath);
        if (!language) {
          continue;
        }

        const imports = parseImports(content, filePath, language);
        for (const parsedImport of imports) {
          const resolved = resolver.resolve(parsedImport.module, filePath);
          if (!resolved) {
            continue;
          }

          const edgeKey = `${filePath}=>${resolved}`;
          if (!edgeSet.has(edgeKey)) {
            edges.push({ source: filePath, target: resolved, type: 'import' });
            edgeSet.add(edgeKey);
          }
        }

        processedCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[Graph] Failed to process ${filePath}:`, message);
      }
    }

    const newShas: Record<string, string> = {};
    for (const file of files) {
      newShas[file.path] = file.sha;
    }

    nodes.sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => {
      const sourceCompare = a.source.localeCompare(b.source);
      if (sourceCompare !== 0) {
        return sourceCompare;
      }
      return a.target.localeCompare(b.target);
    });

    const graph: DependencyGraph = {
      nodes,
      edges,
      locks: {},
      version: currentHead,
      metadata: {
        generated_at: Date.now(),
        files_processed: processedCount,
        edges_found: edges.length,
      },
    };

    const pipeline = (kv as any).pipeline();
    pipeline.set(keys.graph, JSON.stringify(graph));
    pipeline.set(keys.meta, currentHead);

    if (deletedFiles.length > 0) {
      pipeline.hdel(keys.fileShas, ...deletedFiles);
    }

    if (Object.keys(newShas).length > 0) {
      pipeline.hset(keys.fileShas, newShas);
    }

    await pipeline.exec();

    const elapsed = Date.now() - startTime;
    console.log(`[Graph] Complete in ${elapsed}ms: ${nodes.length} nodes, ${edges.length} edges`);

    graph.locks = await getLocks(this.repoUrl, this.branch);
    return graph;
  }

  async get(forceRegenerate = false): Promise<DependencyGraph> {
    if (forceRegenerate) {
      return this.generate(true);
    }

    const cached = await this.getCached();
    if (cached) {
      const { needsUpdate } = await this.needsUpdate();
      if (!needsUpdate) {
        return cached;
      }
    }

    return this.generate();
  }
}
