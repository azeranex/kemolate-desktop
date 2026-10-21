// Desktop: the web build's relations, for the tables `schema.ts` keeps — nothing onto users,
// contributors or invites, which the desktop does not have.
import { defineRelations } from 'drizzle-orm'

import * as schema from './schema'

export const relations = defineRelations(schema, (r) => ({
  workspaces: {
    pages: r.many.pages(),
    layers: r.many.layers(),
    glossaries: r.many.glossaries(),
    cast: r.many.castMembers(),
    logs: r.many.logs(),
  },
  pages: {
    workspace: r.one.workspaces({
      from: r.pages.workspaceId,
      to: r.workspaces.id,
      optional: false,
    }),
    blocks: r.many.blocks(),
    surfaces: r.many.surfaces(),
    repairs: r.many.repairs(),
  },
  repairs: {
    page: r.one.pages({
      from: r.repairs.pageId,
      to: r.pages.id,
      optional: false,
    }),
    block: r.one.blocks({
      from: r.repairs.blockId,
      to: r.blocks.id,
    }),
  },
  layers: {
    workspace: r.one.workspaces({
      from: r.layers.workspaceId,
      to: r.workspaces.id,
      optional: false,
    }),
    // The stack nests, so a layer points at its own table both ways.
    parent: r.one.layers({
      from: r.layers.parentId,
      to: r.layers.id,
      alias: 'layerTree',
    }),
    children: r.many.layers({
      alias: 'layerTree',
    }),
    surfaces: r.many.surfaces(),
  },
  surfaces: {
    page: r.one.pages({
      from: r.surfaces.pageId,
      to: r.pages.id,
      optional: false,
    }),
    layer: r.one.layers({
      from: r.surfaces.layerId,
      to: r.layers.id,
      optional: false,
    }),
    block: r.one.blocks({
      from: r.surfaces.blockId,
      to: r.blocks.id,
    }),
    strokes: r.many.strokes(),
  },
  strokes: {
    surface: r.one.surfaces({
      from: r.strokes.surfaceId,
      to: r.surfaces.id,
      optional: false,
    }),
  },
  blocks: {
    page: r.one.pages({
      from: r.blocks.pageId,
      to: r.pages.id,
      optional: false,
    }),
    translations: r.many.translations(),
    /** The retouching that covers this block, where somebody has cleaned it. */
    surface: r.one.surfaces({
      from: r.blocks.id,
      to: r.surfaces.blockId,
    }),
    /**
     * The balloon this block is a part of, where somebody joined it to others,
     * and the parts of it where this *is* one — a compound path either way.
     * Both null and empty on an ordinary block, which is nearly all of them.
     */
    parent: r.one.blocks({
      from: r.blocks.parentId,
      to: r.blocks.id,
      alias: 'compound',
    }),
    children: r.many.blocks({ alias: 'compound' }),
  },
  translations: {
    block: r.one.blocks({
      from: r.translations.blockId,
      to: r.blocks.id,
      optional: false,
    }),
    /**
     * Every wording this line has had. Not `revisionId` — that column names the
     * *head* and deliberately carries no foreign key (see the schema), so it is
     * resolved in the service rather than declared here.
     */
    revisions: r.many.translationRevisions(),
  },
  translationRevisions: {
    translation: r.one.translations({
      from: r.translationRevisions.translationId,
      to: r.translations.id,
      optional: false,
    }),
  },
  glossaries: {
    workspace: r.one.workspaces({
      from: r.glossaries.workspaceId,
      to: r.workspaces.id,
      optional: false,
    }),
    terms: r.many.glossaryTerms(),
  },
  castMembers: {
    workspace: r.one.workspaces({
      from: r.castMembers.workspaceId,
      to: r.workspaces.id,
      optional: false,
    }),
  },
  glossaryTerms: {
    glossary: r.one.glossaries({
      from: r.glossaryTerms.glossaryId,
      to: r.glossaries.id,
      optional: false,
    }),
  },
  logs: {
    workspace: r.one.workspaces({
      from: r.logs.workspaceId,
      to: r.workspaces.id,
      optional: false,
    }),
  },
}))
