import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SearchX, ArrowLeft, Home } from "lucide-react";

export function NotFound() {
  const navigate = useNavigate();
  const { t } = useTranslation("errors");

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center animate-fade-in">
      <div className="card max-w-xl w-full p-8 md:p-10 text-center">
        <div className="w-14 h-14 mx-auto mb-5 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center">
          <SearchX className="w-7 h-7 text-accent" />
        </div>

        <p className="text-xs uppercase tracking-[0.18em] text-slate-500 mb-2">
          {t("notFound.code")}
        </p>
        <h2 className="text-2xl font-semibold text-slate-100 mb-2">{t("notFound.title")}</h2>
        <p className="text-sm text-slate-400 mb-8">{t("notFound.description")}</p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button className="btn-primary" onClick={() => navigate("/")}>
            <Home className="w-4 h-4" />
            {t("notFound.goDashboard")}
          </button>
          <button
            className="btn-ghost border border-border hover:border-border-light"
            onClick={() => navigate(-1)}
          >
            <ArrowLeft className="w-4 h-4" />
            {t("notFound.goBack")}
          </button>
        </div>
      </div>
    </div>
  );
}
