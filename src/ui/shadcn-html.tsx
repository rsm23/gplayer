import type * as React from 'react'
import serializeDom from 'dom-serializer'
import { renderToStaticMarkup } from 'react-dom/server'
import * as htmlReactParser from 'html-react-parser'
import { attributesToProps, domToReact, Element, Text, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser'

import { Alert } from '../components/ui/alert.js'
import { Badge, badgeVariants } from '../components/ui/badge.js'
import { Button, buttonVariants } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { Empty, EmptyDescription } from '../components/ui/empty.js'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { NativeCheck } from '../components/ui/native-check.js'
import { NativeSelect } from '../components/ui/native-select.js'
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '../components/ui/table.js'
import { Textarea } from '../components/ui/textarea.js'
import { cn } from '../lib/utils.js'

export const SHADCN_STYLESHEET = '/assets/css/gplayer-ui.css'

type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link'
type ButtonSize = 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'

const destructivePattern = /(?:delete|remove|revoke|danger|reset|takedown|dmca)/iu
const outlinePattern = /(?:back-link|menu-toggle|logout|text-button|copy-control|cancel|close|toolbar)/iu
const ghostPattern = /(?:goto-top|share-more|share-network|public-share-rail|theme-choice|fake-play|ad-gate)/iu
const primaryPattern = /(?:generate-button|public-button|hero-link-primary|nav-cta|button-watch|button-download|offline|submit|primary)/iu
const buttonLinkPattern = /(?:public-button|hero-link-primary|hero-link-secondary|admin-back-link|nav-cta|settings-add-rule|(?:^|\s)button(?:\s|$))/u
const badgePattern = /(?:^|\s)(?:admin-role|user-state(?:-[^\s]+)?|release-tag|signal-label|source-token|output-token|system-service-state)(?:\s|$)/u
const emptyPattern = /(?:^|\s)(?:dashboard-empty|download-empty|public-empty)(?:\s|$)/u
const cardPattern = /(?:^|\s)(?:admin-auth-panel|dashboard-panel|download-card|hosting-provider-card|settings-[^\s]+-card|sharer-card|video-(?:bulk-panel|checker-card|transfer-card))(?:\s|$)/u

export function withShadcnUi(document: string): string {
  const bodyStart = document.search(/<body\b/iu)
  if (bodyStart < 0) return document
  const bodyOpenEnd = document.indexOf('>', bodyStart)
  const bodyClose = document.toLowerCase().lastIndexOf('</body>')
  if (bodyOpenEnd < 0 || bodyClose < bodyOpenEnd) return document

  const openTag = document.slice(bodyStart, bodyOpenEnd + 1)
  const enhancedOpenTag = /\sdata-ui=/iu.test(openTag)
    ? openTag
    : openTag.replace(/<body\b/iu, '<body data-ui="shadcn"')
  const enhancedBody = enhanceShadcnFragment(document.slice(bodyOpenEnd + 1, bodyClose))
  let result = `${document.slice(0, bodyStart)}${enhancedOpenTag}${enhancedBody}${document.slice(bodyClose)}`

  if (!result.includes(`href="${SHADCN_STYLESHEET}"`)) {
    const headClose = result.toLowerCase().lastIndexOf('</head>')
    if (headClose >= 0) {
      result = `${result.slice(0, headClose)}  <link rel="stylesheet" href="${SHADCN_STYLESHEET}" data-shadcn-styles>\n${result.slice(headClose)}`
    }
  }
  return result
}

export function enhanceShadcnFragment(fragment: string): string {
  const comments: string[] = []
  const prepared = fragment.replaceAll(/<!--[\s\S]*?-->/gu, (comment) => {
    const index = comments.push(comment) - 1
    return `<template data-shadcn-comment="${index}"></template>`
  })
  const parse = htmlReactParser.default as unknown as (html: string, options?: HTMLReactParserOptions) => ReturnType<typeof domToReact>
  return normalizeRenderedHtml(renderToStaticMarkup(<>{parse(prepared, parserOptions)}</>))
    .replaceAll(/<link rel="preload" as="image" href="[^"]+"\/>/giu, '')
    .replaceAll(/<template data-shadcn-comment="(\d+)"><\/template>/gu, (_sentinel, index: string) => comments[Number(index)] ?? '')
    .replaceAll(/\s(data-[a-z0-9-]+)=""/giu, ' $1')
}

const parserOptions: HTMLReactParserOptions = {
  replace(node) {
    if (!(node instanceof Element) || node.type !== 'tag' || node.attribs['data-slot'] !== undefined) return
    const props = attributesToProps(node.attribs, node.name) as unknown as Record<string, unknown>
    const originalClass = node.attribs.class ?? ''
    const children = domToReact(node.children as DOMNode[], parserOptions)

    if (node.name === 'form') {
      return <form {...asProps<React.ComponentProps<'form'>>(props)} data-slot="form"><FieldGroup className="contents">{children}</FieldGroup></form>
    }

    if (node.name === 'div' && hasClass(originalClass, 'field')) {
      return <Field {...asProps<React.ComponentProps<typeof Field>>(props)}>{children}</Field>
    }

    if ((node.name === 'div' || node.name === 'article' || node.name === 'section') && cardPattern.test(originalClass)) {
      return <Card {...asProps<React.ComponentProps<typeof Card>>(props)} as={node.name}>{children}</Card>
    }

    if (node.name === 'label') {
      const parentClass = node.parent instanceof Element ? node.parent.attribs.class ?? '' : ''
      if (hasClass(parentClass, 'field')) {
        return <FieldLabel {...asProps<React.ComponentProps<typeof FieldLabel>>(props)}>{children}</FieldLabel>
      }
      return <Label {...asProps<React.ComponentProps<typeof Label>>(props)}>{children}</Label>
    }

    if (node.name === 'p' && hasClass(originalClass, 'field-hint')) {
      return <FieldDescription {...asProps<React.ComponentProps<typeof FieldDescription>>(props)}>{children}</FieldDescription>
    }

    if (node.name === 'button') {
      return <Button {...asProps<React.ComponentProps<typeof Button>>(props)} variant={buttonVariant(node)} size={buttonSize(node)}>{children}</Button>
    }

    if (node.name === 'a' && isButtonLink(node, originalClass)) {
      const variant = buttonVariant(node)
      const size = buttonSize(node)
      const anchorProps = asProps<React.ComponentProps<'a'>>(props)
      const { className: _className, ...rest } = anchorProps
      return <a
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(originalClass, buttonVariants({ variant, size }))}
        {...rest}
      >{children}</a>
    }

    if (node.name === 'input') {
      const type = (node.attribs.type ?? 'text').toLowerCase()
      if (type === 'hidden') return
      if (type === 'checkbox' || type === 'radio') {
        return <NativeCheck {...asProps<React.ComponentProps<typeof NativeCheck>>(props)} type={type} />
      }
      return <Input {...asProps<React.ComponentProps<typeof Input>>(props)} />
    }

    if (node.name === 'textarea') {
      const textareaProps = asProps<React.ComponentProps<typeof Textarea>>(props)
      const value = node.children.map((child) => child instanceof Text ? child.data : '').join('')
      return <Textarea {...textareaProps} defaultValue={value} />
    }

    if (node.name === 'select') {
      const selectProps = asProps<React.ComponentProps<typeof NativeSelect>>(props)
      const { className: _className, ...rest } = selectProps
      return <NativeSelect
        {...rest}
        className="w-full"
        selectClassName={originalClass}
        optionsHtml={serializeDom(node.children, { emptyAttrs: false })}
      />
    }

    if (node.name === 'table') return <Table {...asProps<React.ComponentProps<typeof Table>>(props)}>{children}</Table>
    if (node.name === 'thead') return <TableHeader {...asProps<React.ComponentProps<typeof TableHeader>>(props)}>{children}</TableHeader>
    if (node.name === 'tbody') return <TableBody {...asProps<React.ComponentProps<typeof TableBody>>(props)}>{children}</TableBody>
    if (node.name === 'tfoot') return <TableFooter {...asProps<React.ComponentProps<typeof TableFooter>>(props)}>{children}</TableFooter>
    if (node.name === 'tr') return <TableRow {...asProps<React.ComponentProps<typeof TableRow>>(props)}>{children}</TableRow>
    if (node.name === 'th') return <TableHead {...asProps<React.ComponentProps<typeof TableHead>>(props)}>{children}</TableHead>
    if (node.name === 'td') return <TableCell {...asProps<React.ComponentProps<typeof TableCell>>(props)}>{children}</TableCell>
    if (node.name === 'caption') return <TableCaption {...asProps<React.ComponentProps<typeof TableCaption>>(props)}>{children}</TableCaption>

    if ((node.name === 'div' || node.name === 'section') && node.attribs.role === 'alert') {
      return <Alert {...asProps<React.ComponentProps<typeof Alert>>(props)}>{children}</Alert>
    }

    if (node.name === 'span' && badgePattern.test(originalClass)) {
      const variant = destructivePattern.test(originalClass) ? 'destructive' : 'secondary'
      return <Badge {...asProps<React.ComponentProps<typeof Badge>>(props)} variant={variant}>{children}</Badge>
    }

    if (node.name === 'p' && emptyPattern.test(originalClass)) {
      return <Empty className={originalClass}><EmptyDescription>{children}</EmptyDescription></Empty>
    }
  }
}

function normalizeRenderedHtml(html: string): string {
  const attributeNames: Readonly<Record<string, string>> = Object.freeze({
    allowFullScreen: 'allowfullscreen',
    autoComplete: 'autocomplete',
    autoPlay: 'autoplay',
    crossOrigin: 'crossorigin',
    dateTime: 'datetime',
    encType: 'enctype',
    formAction: 'formaction',
    formEncType: 'formenctype',
    formMethod: 'formmethod',
    formNoValidate: 'formnovalidate',
    formTarget: 'formtarget',
    inputMode: 'inputmode',
    maxLength: 'maxlength',
    minLength: 'minlength',
    noModule: 'nomodule',
    noValidate: 'novalidate',
    playsInline: 'playsinline',
    readOnly: 'readonly',
    referrerPolicy: 'referrerpolicy',
    srcSet: 'srcset',
    tabIndex: 'tabindex'
  })
  const normalizedNames = html.replaceAll(/\b(allowFullScreen|autoComplete|autoPlay|crossOrigin|dateTime|encType|formAction|formEncType|formMethod|formNoValidate|formTarget|inputMode|maxLength|minLength|noModule|noValidate|playsInline|readOnly|referrerPolicy|srcSet|tabIndex)=/gu, (match, name: string) => `${attributeNames[name] ?? name}=`)
  return normalizedNames.replaceAll(/\s(allowfullscreen|async|autofocus|autoplay|checked|controls|default|defer|disabled|formnovalidate|hidden|loop|multiple|muted|nomodule|novalidate|open|playsinline|readonly|required|reversed|selected)=""/giu, ' $1')
}

function asProps<T>(value: Record<string, unknown>): T {
  return value as T
}

function hasClass(className: string, target: string): boolean {
  return className.split(/\s+/u).includes(target)
}

function buttonVariant(node: Element): ButtonVariant {
  const parentClass = node.parent instanceof Element ? node.parent.attribs.class ?? '' : ''
  const signature = `${node.attribs.class ?? ''} ${parentClass} ${Object.keys(node.attribs).join(' ')}`
  if (destructivePattern.test(signature)) return 'destructive'
  if (ghostPattern.test(signature)) return 'ghost'
  if (outlinePattern.test(signature)) return 'outline'
  if (primaryPattern.test(signature) || node.attribs.type === 'submit') return 'default'
  return 'secondary'
}

function isButtonLink(node: Element, className: string): boolean {
  const parentClass = node.parent instanceof Element ? node.parent.attribs.class ?? '' : ''
  return buttonLinkPattern.test(className)
    || /(?:^|\s)(?:offline|player-toolbar|public-share-rail)(?:\s|$)/u.test(parentClass)
    || node.attribs.id === 'open-player'
    || node.attribs['data-share-network'] !== undefined
}

function buttonSize(node: Element): ButtonSize {
  const signature = `${node.attribs.class ?? ''} ${Object.keys(node.attribs).join(' ')}`
  if (/(?:goto-top|share-more|fake-play|ad-gate|close)/iu.test(signature)) return 'icon'
  if (/(?:toolbar|row-action|copy-control|text-button)/iu.test(signature)) return 'sm'
  return 'default'
}

export function shadcnBadgeClass(variant: 'default' | 'secondary' | 'destructive' | 'outline' = 'secondary'): string {
  return badgeVariants({ variant })
}
