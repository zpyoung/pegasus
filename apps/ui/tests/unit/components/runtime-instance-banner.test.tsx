import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RuntimeInstanceBanner } from '../../../src/components/layout/runtime-instance-banner';
import { useRuntimeInstance } from '@/hooks/queries';

vi.mock('@/hooks/queries', () => ({
  useRuntimeInstance: vi.fn(),
}));

const mockUseRuntimeInstance = vi.mocked(useRuntimeInstance);

describe('RuntimeInstanceBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders for non-main runtime branches', () => {
    mockUseRuntimeInstance.mockReturnValue({
      data: {
        bannerVersion: '1.2.3',
        bannerBranch: 'feature/runtime-banner',
        runtimeChannel: 'development',
        isPackagedRelease: false,
      },
    } as ReturnType<typeof useRuntimeInstance>);

    render(<RuntimeInstanceBanner />);

    expect(screen.getByTestId('runtime-instance-banner')).toBeInTheDocument();
    expect(screen.getByText('Non-main Pegasus instance')).toBeInTheDocument();
    expect(screen.getByText('feature/runtime-banner')).toBeInTheDocument();
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  });

  it('does not render for the main branch', () => {
    mockUseRuntimeInstance.mockReturnValue({
      data: {
        bannerVersion: '1.2.3',
        bannerBranch: 'main',
        runtimeChannel: 'development',
        isPackagedRelease: false,
      },
    } as ReturnType<typeof useRuntimeInstance>);

    const { container } = render(<RuntimeInstanceBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('does not render for hidden branch names regardless of casing or whitespace', () => {
    mockUseRuntimeInstance.mockReturnValue({
      data: {
        bannerVersion: '1.2.3',
        bannerBranch: '  MASTER  ',
        runtimeChannel: 'development',
        isPackagedRelease: false,
      },
    } as ReturnType<typeof useRuntimeInstance>);

    const { container } = render(<RuntimeInstanceBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('does not render for packaged releases', () => {
    mockUseRuntimeInstance.mockReturnValue({
      data: {
        bannerVersion: '1.2.3',
        bannerBranch: 'release',
        runtimeChannel: 'packaged',
        isPackagedRelease: true,
      },
    } as ReturnType<typeof useRuntimeInstance>);

    const { container } = render(<RuntimeInstanceBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('does not render for unknown branch placeholders', () => {
    mockUseRuntimeInstance.mockReturnValue({
      data: {
        bannerVersion: '1.2.3',
        bannerBranch: 'unknown',
        runtimeChannel: 'development',
        isPackagedRelease: false,
      },
    } as ReturnType<typeof useRuntimeInstance>);

    const { container } = render(<RuntimeInstanceBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('does not render when runtime metadata is unavailable', () => {
    mockUseRuntimeInstance.mockReturnValue({
      data: null,
    } as ReturnType<typeof useRuntimeInstance>);

    const { container } = render(<RuntimeInstanceBanner />);

    expect(container).toBeEmptyDOMElement();
  });
});
