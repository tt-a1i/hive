import { useI18n } from '../i18n.js'
import { localizeMarketplaceCategory } from './categoryLabels.js'

interface CategoryTreeProps {
  categories: readonly string[]
  selected: string | null
  onSelect: (category: string | null) => void
  counts?: Record<string, number>
  showAll: boolean
  onToggleShowAll: () => void
  hiddenCount: number
}

interface RowProps {
  label: string
  count: number | undefined
  active: boolean
  onClick: () => void
}

const Row = ({ label, count, active, onClick }: RowProps) => (
  <button
    type="button"
    onClick={onClick}
    data-active={active ? 'true' : 'false'}
    className={`marketplace-category-row flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-sm transition-all ${
      active ? 'font-semibold text-pri' : 'text-sec hover:text-pri'
    }`}
  >
    <div className="flex items-center gap-2 min-w-0">
      <span className="truncate">{label}</span>
    </div>
    {count !== undefined ? (
      <span className="tabular-nums text-[10px] px-1.5 py-0.5 rounded-full bg-3/40 text-ter border border-bright/10 font-semibold transition-colors">
        {count}
      </span>
    ) : null}
  </button>
)

export const MarketplaceCategoryTree = ({
  categories,
  selected,
  onSelect,
  counts,
  showAll,
  onToggleShowAll,
  hiddenCount,
}: CategoryTreeProps) => {
  const { t, language } = useI18n()
  const totalCount = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : undefined

  return (
    <nav className="flex flex-col gap-1" data-testid="marketplace-category-tree">
      <Row
        label={t('marketplace.allCategories')}
        count={totalCount}
        active={selected === null}
        onClick={() => onSelect(null)}
      />
      {categories.map((category) => (
        <Row
          key={category}
          label={localizeMarketplaceCategory(category, language)}
          count={counts?.[category]}
          active={selected === category}
          onClick={() => onSelect(category)}
        />
      ))}
      {hiddenCount > 0 || showAll ? (
        <div className="mt-2 pt-2 border-t border-bright/20">
          <button
            type="button"
            onClick={onToggleShowAll}
            data-testid="marketplace-toggle-show-all"
            className="marketplace-toggle-row flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium text-sec hover:text-pri transition-all"
          >
            {showAll
              ? t('marketplace.showCoreOnly')
              : t('marketplace.showAllCategories', { count: hiddenCount })}
          </button>
        </div>
      ) : null}
    </nav>
  )
}
